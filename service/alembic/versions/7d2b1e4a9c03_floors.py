"""floors: a building job owns one job per approved floor

Revision ID: 7d2b1e4a9c03
Revises: 361920f49c45
Create Date: 2026-10-13

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7d2b1e4a9c03"
down_revision: Union[str, Sequence[str], None] = "361920f49c45"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("kind", sa.String(length=10), nullable=False, server_default="single"))
    op.add_column("jobs", sa.Column("parent_job_id", sa.String(length=26), nullable=True))
    op.add_column("jobs", sa.Column("floor", sa.JSON(), nullable=True))
    op.create_foreign_key("fk_jobs_parent_job_id", "jobs", "jobs", ["parent_job_id"], ["id"], ondelete="CASCADE")
    op.create_index(op.f("ix_jobs_parent_job_id"), "jobs", ["parent_job_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_jobs_parent_job_id"), table_name="jobs")
    op.drop_constraint("fk_jobs_parent_job_id", "jobs", type_="foreignkey")
    op.drop_column("jobs", "floor")
    op.drop_column("jobs", "parent_job_id")
    op.drop_column("jobs", "kind")
