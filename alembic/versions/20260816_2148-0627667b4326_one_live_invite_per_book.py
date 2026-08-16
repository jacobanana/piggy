"""one live invite per book

Revision ID: 0627667b4326
Revises: 8e650f41c4c4
Create Date: 2026-08-16 21:48:25.336961

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0627667b4326"
down_revision: str | None = "8e650f41c4c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Retire every live invite but the newest one per book.

    Data only — the table is unchanged. Until now "Make an invite link" minted
    a fresh code on every press, so a book could carry several live ones while
    the share screen showed a nameless pile of them. From here a book has at
    most one live link, and it is the one the owner can see and revoke.
    """
    op.execute(
        sa.text(
            """
            UPDATE book_invites SET revoked_at = now()
            WHERE revoked_at IS NULL
              AND expires_at > now()
              AND id NOT IN (
                SELECT DISTINCT ON (book_id) id FROM book_invites
                WHERE revoked_at IS NULL AND expires_at > now()
                ORDER BY book_id, created_at DESC
              )
            """
        )
    )


def downgrade() -> None:
    """Nothing to undo: which codes were revoked when isn't recoverable, and
    un-revoking them would hand back access somebody deliberately lost."""
