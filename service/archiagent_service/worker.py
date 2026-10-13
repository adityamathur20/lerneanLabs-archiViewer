"""The RQ entry point: object storage in, object storage out.

Tier 1 reads a directory and writes a directory; this does the I/O around it so
the CLI stays exactly as testable as it is today (spec §5.3).
"""
import json
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from sqlalchemy import select

from archiagent_service.config import get_settings
from archiagent_service.db import session_scope
from archiagent_service.models import Job, ulid
from archiagent_service.pipeline import (
    CLASSIFICATION_FILE,
    EXIT_MEANING,
    archiagent_version,
    collect_artifacts,
    read_acceptance,
)
from archiagent_service.pipeline import (
    run_assemble, run_classify, run_cli, run_cut_floors, run_detect_floors, run_prepare,
)
from archiagent_service.queue import claim_slot, get_queue, on_failure
from archiagent_service.storage import get_store

#: The CLI derives its output stem from the input filename, so the working copy
#: is named `plan.dxf` to make the artifacts `plan.ifc`, `plan.report.json` …
#: exactly as the spec §3 contract names them. Tier 2's cache key is keyed on
#: `plan.ifc`; it should not have to guess the stem.
WORKING_STEM = "plan"

#: How long to wait before re-checking when the tenant is at its cap.
REQUEUE_DELAY_S = 30


def _finish(job_id: str, **fields) -> None:
    """Write the terminal state, tolerating a job row that was deleted mid-run."""
    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        for key, value in fields.items():
            setattr(job, key, value)
        job.finished_at = datetime.now(timezone.utc)


#: A job in one of these has not reached an outcome yet.
UNFINISHED = ("preparing", "queued", "running", "building", "assembling")

FLOORS_FILE = "plan.floors.json"
DECIDED_FILE = "floors.decided.json"


def mark_failed(rq_job, connection, exc_type, exc_value, tb) -> None:
    """RQ's on_failure. When the work-horse dies, run_job/prepare_job never
    reach their own handlers, and the job would stay unfinished forever while
    the UI polls it. Leaves a job that already finished alone."""
    job_id = rq_job.args[0] if getattr(rq_job, "args", None) else None
    if not job_id:
        return
    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None or job.status not in UNFINISHED:
            return
        job.status = "failed"
        job.error = f"the worker process ended before finishing: {exc_value}"
        job.finished_at = datetime.now(timezone.utc)
        parent_id = job.parent_job_id
    if parent_id:
        _floor_finished(parent_id)


def mark_horse_killed(rq_job, retpid, ret_val, rusage) -> None:
    """Worker's work_horse_killed_handler (queue.Worker)."""
    mark_failed(rq_job, None, RuntimeError,
                RuntimeError(f"work-horse {retpid} was killed (status {ret_val})"), None)


def prepare_job(job_id: str) -> None:
    """Convert a DWG (ODA) and read the drawing's scale evidence; leave the job
    `ready` for the user to choose a scale. Stores plan.dxf -- the drawing the
    Drawing view opens -- and plan.scale.json. No model is called."""
    store = get_store()
    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        prefix, filename = job.prefix, job.source_filename
    suffix = PurePosixPath(filename).suffix.lower()
    try:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            source = work / f"{WORKING_STEM}{suffix}"
            store.download(f"{prefix}source{suffix}", source)
            result = run_prepare(source, work)
            artifacts = []
            if result.exit_code == 0:
                for name in (f"{WORKING_STEM}.dxf", f"{WORKING_STEM}.scale.json"):
                    path = work / name
                    if path.is_file():
                        store.put_file(f"{prefix}{name}", path)
                        artifacts.append(name)
    except Exception as error:
        _finish(job_id, status="failed",
                error=f"{type(error).__name__}: {error}\n{traceback.format_exc()[-2000:]}",
                converted_from_dwg=suffix == ".dwg")
        raise

    ok = result.exit_code == 0 and len(artifacts) == 2
    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "ready" if ok else "failed"
        job.artifacts = artifacts
        job.converted_from_dwg = suffix == ".dwg"
        job.timings_ms = {**(job.timings_ms or {}), "prepare": result.duration_ms}
        if not ok:
            job.exit_code = result.exit_code
            job.error = (f"{EXIT_MEANING.get(result.exit_code, 'unknown')}: {result.stderr[-4000:]}"
                         if result.exit_code else "prepare produced no drawing")
            job.finished_at = datetime.now(timezone.utc)


def run_job(job_id: str) -> None:
    settings = get_settings()
    store = get_store()

    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            # DELETE removed it while it sat in the queue. Nothing to do, and
            # nothing to crash on.
            return
        # The cap is enforced here, not at submission: a tenant may submit a
        # batch freely, and the queue paces it (Review Focus #4).
        if not claim_slot(session, job.tenant_id, settings.tenant_max_concurrent):
            get_queue().enqueue_in(
                __import__("datetime").timedelta(seconds=REQUEUE_DELAY_S),
                "archiagent_service.worker.run_job",
                job_id,
                on_failure=on_failure(),
            )
            return
        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        prefix, filename, options = job.prefix, job.source_filename, dict(job.options)
        prepared = [name for name in job.artifacts or ()
                    if name in ("plan.dxf", "plan.scale.json", CLASSIFICATION_FILE)]
        parent_id = job.parent_job_id

    suffix = PurePosixPath(filename).suffix.lower()
    try:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            if "plan.dxf" in prepared:
                # Prepared: run on the stored DXF -- the drawing the user saw
                # and measured on. A DWG is converted once, at prepare.
                source = work / f"{WORKING_STEM}.dxf"
                store.download(f"{prefix}{source.name}", source)
            else:
                source = work / f"{WORKING_STEM}{suffix}"
                store.download(f"{prefix}source{suffix}", source)

            if options.get("floors") == "detect" and source.suffix == ".dxf":
                waiting = _detect_floors(job_id, prefix, store, work, source, options)
                if waiting is not None:
                    return
            if CLASSIFICATION_FILE in prepared:
                # One classification for the whole file, made once and shared by
                # every floor run (spec section 6).
                shared = work / CLASSIFICATION_FILE
                store.download(f"{prefix}{CLASSIFICATION_FILE}", shared)
                options = {**options, "classification_file": str(shared)}

            result = run_cli(source, work, options)
            acceptance = read_acceptance(work)
            artifacts = [name for name in prepared if name not in ("plan.dxf",)]
            # `plan.dxf` is the drawing the viewer opens, whichever format was
            # uploaded. For a DWG it is ODA's conversion, which is also the only
            # way to reproduce or debug a DWG-derived result: ODA's output is
            # not byte-deterministic. For a DXF it is the working copy of the
            # source itself. The browser never receives a DWG.
            drawing = work / f"{WORKING_STEM}.dxf"
            if suffix in (".dwg", ".dxf") and drawing.is_file():
                store.put_file(f"{prefix}{drawing.name}", drawing)
                artifacts.append(drawing.name)
            for path in collect_artifacts(work):
                store.put_file(f"{prefix}{path.name}", path)
                artifacts.append(path.name)
    except Exception as error:
        # Anything that is not "the CLI exited nonzero" — an S3 outage, OOM, a
        # container restart — must still leave a job the user can see and a cap
        # slot that frees. Otherwise two crashes permanently block the tenant.
        _finish(
            job_id,
            status="failed",
            error=f"{type(error).__name__}: {error}\n{traceback.format_exc()[-2000:]}",
            # Provenance belongs on the failure path too: a DWG job that dies
            # on an S3 outage is still a DWG job.
            converted_from_dwg=suffix == ".dwg",
        )
        if parent_id:
            _floor_finished(parent_id)
        raise

    _finish(
        job_id,
        exit_code=result.exit_code,
        status="succeeded" if result.exit_code == 0 else "failed",
        # A failed run is exactly when the diagnostics matter, so they are kept
        # and the job stays retrievable rather than vanishing.
        error=None if result.exit_code == 0 else (
            f"{EXIT_MEANING.get(result.exit_code, 'unknown')}: {result.stderr[-4000:]}"
        ),
        acceptance=acceptance,
        artifacts=artifacts,
        timings_ms={"author": result.duration_ms},
        archiagent_version=archiagent_version(),
        converted_from_dwg=suffix == ".dwg",
    )
    if parent_id:
        _floor_finished(parent_id)


def _detect_floors(job_id, prefix, store, work, source, options):
    """Look for several floors in the drawing the run is about to build.

    One plan (or detection failing) leaves the job to run as it always did and
    returns None. Two or more stop it here, `awaiting_floors`, with the floors
    and one shared layer classification stored for the user's decision.
    """
    detected = run_detect_floors(source, options)
    if detected.exit_code != 0:
        return None
    try:
        found = json.loads(detected.stdout)
    except json.JSONDecodeError:
        return None
    if len(found.get("floors") or ()) < 2:
        return None
    classification = work / CLASSIFICATION_FILE
    classified = run_classify(source, classification, options)
    if classified.exit_code != 0 or not classification.is_file():
        _finish(job_id, status="failed", exit_code=classified.exit_code,
                error=f"{EXIT_MEANING.get(classified.exit_code, 'unknown')}: {classified.stderr[-4000:]}",
                timings_ms={"detect_floors": detected.duration_ms, "classify": classified.duration_ms})
        return "failed"
    store.put(f"{prefix}{FLOORS_FILE}", detected.stdout.encode())
    store.put_file(f"{prefix}{CLASSIFICATION_FILE}", classification)
    store.put_file(f"{prefix}plan.dxf", source)         # the drawing every floor is cut from
    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            return "gone"
        job.status = "awaiting_floors"
        kept = [n for n in job.artifacts or () if n not in (FLOORS_FILE, CLASSIFICATION_FILE, "plan.dxf")]
        job.artifacts = [*kept, "plan.dxf", FLOORS_FILE, CLASSIFICATION_FILE]
        job.timings_ms = {**(job.timings_ms or {}), "detect_floors": detected.duration_ms,
                          "classify": classified.duration_ms}
    return "awaiting"


def start_floors(parent_id: str) -> None:
    """Cut each approved floor out of the drawing and queue one run per floor."""
    store = get_store()
    with session_scope() as session:
        parent = session.get(Job, parent_id)
        if parent is None or parent.status != "building":
            return
        prefix, tenant_id, filename = parent.prefix, parent.tenant_id, parent.source_filename
        options = {k: v for k, v in dict(parent.options).items() if k not in ("walls", "floors")}
    try:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            drawing, decided = work / "plan.dxf", work / DECIDED_FILE
            store.download(f"{prefix}plan.dxf", drawing)
            store.download(f"{prefix}{DECIDED_FILE}", decided)
            cut = run_cut_floors(drawing, decided, work / "floors")
            if cut.exit_code != 0:
                raise RuntimeError(f"could not cut the floors: {cut.stderr[-1500:]}")
            records = [f for f in json.loads(decided.read_text())["floors"] if f.get("approved", True)]
            children = []
            for record in records:
                cut_file = work / "floors" / f"{record['id']}.dxf"
                child = Job(id=ulid(), tenant_id=tenant_id, status="queued", kind="floor",
                            parent_job_id=parent_id, floor=record, source_filename=f"{record['id']}.dxf",
                            source_bytes=cut_file.stat().st_size, options={**options, "floors": "off"},
                            artifacts=["plan.dxf", CLASSIFICATION_FILE])
                store.put_file(f"{child.prefix}plan.dxf", cut_file)
                store.copy(f"{prefix}{CLASSIFICATION_FILE}", f"{child.prefix}{CLASSIFICATION_FILE}")
                children.append(child)
            with session_scope() as session:
                for child in children:
                    session.add(child)
    except Exception as error:
        _finish(parent_id, status="failed", error=f"{type(error).__name__}: {error}")
        raise
    for child in children:
        get_queue().enqueue("archiagent_service.worker.run_job", child.id, on_failure=on_failure())


def _floor_finished(parent_id: str) -> None:
    """When the last floor has finished, queue the assembly - exactly once."""
    with session_scope() as session:
        parent = session.execute(select(Job).where(Job.id == parent_id).with_for_update()).scalar_one_or_none()
        if parent is None or parent.status != "building":
            return
        kids = session.query(Job).filter_by(parent_job_id=parent_id).all()
        if not kids or any(k.status not in ("succeeded", "failed") for k in kids):
            return
        parent.status = "assembling"
    get_queue().enqueue("archiagent_service.worker.assemble_building", parent_id, on_failure=on_failure())


def assemble_building(parent_id: str) -> None:
    """One IFC from the floors that ran; a floor that failed is named, not guessed."""
    store = get_store()
    with session_scope() as session:
        parent = session.get(Job, parent_id)
        if parent is None:
            return
        prefix = parent.prefix
        kids = session.query(Job).filter_by(parent_job_id=parent_id).order_by(Job.id).all()
        ran = [(k.floor["id"], k.prefix) for k in kids
               if k.status == "succeeded" and "plan.interpretation.json" in (k.artifacts or ())]
        failed = [k.floor["id"] for k in kids if k.status != "succeeded"]
        total = len(kids)
    try:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            floors_json = work / DECIDED_FILE
            store.download(f"{prefix}{DECIDED_FILE}", floors_json)
            floors_dir, out = work / "floors", work / "building"
            for fid, kid_prefix in ran:
                (floors_dir / fid).mkdir(parents=True, exist_ok=True)
                store.download(f"{kid_prefix}plan.dxf", floors_dir / f"{fid}.dxf")
                store.download(f"{kid_prefix}plan.interpretation.json",
                               floors_dir / fid / f"{fid}.interpretation.json")
            result = run_assemble(floors_json, floors_dir, out)
            artifacts = [n for n in _kept(session_artifacts(parent_id))]
            if result.exit_code == 0:
                for path in sorted(out.glob("building.*")):
                    store.put_file(f"{prefix}{path.name}", path)
                    artifacts.append(path.name)
    except Exception as error:
        _finish(parent_id, status="failed", error=f"{type(error).__name__}: {error}")
        raise
    if result.exit_code != 0:
        _finish(parent_id, status="failed", exit_code=result.exit_code,
                error=f"{EXIT_MEANING.get(result.exit_code, 'unknown')}: {result.stderr[-4000:]}")
        return
    status = "succeeded" if not failed and len(ran) == total else "partial"
    _finish(parent_id, status=status, exit_code=0, artifacts=artifacts,
            error=None if status == "succeeded" else f"floors that did not finish: {', '.join(failed)}",
            timings_ms={"assemble": result.duration_ms}, archiagent_version=archiagent_version())


def session_artifacts(job_id: str) -> list:
    with session_scope() as session:
        job = session.get(Job, job_id)
        return list(job.artifacts or ()) if job else []


def _kept(names):
    return [n for n in names if not n.startswith("building.")]
