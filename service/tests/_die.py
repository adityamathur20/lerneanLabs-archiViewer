"""A job that kills its own work-horse, as an OOM kill would."""
import os
import signal


def die(job_id):
    os.kill(os.getpid(), signal.SIGKILL)
