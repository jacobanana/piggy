"""user profile emoji

Revision ID: dca7c2450a3f
Revises: 0627667b4326
Create Date: 2026-08-17 15:59:07.503608

"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "dca7c2450a3f"
down_revision: str | None = "0627667b4326"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The face of the profile a book prefills its first person from. Existing
    # accounts get the same default a new one is born with, so the column can
    # be NOT NULL from the start.
    op.add_column(
        "users",
        sa.Column("emoji", sqlmodel.sql.sqltypes.AutoString(length=16), nullable=False, server_default="🙂"),
    )


def downgrade() -> None:
    op.drop_column("users", "emoji")
