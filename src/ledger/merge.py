"""Three-way merge of two edits to the same book.

Whole-book PUT plus more than one member is a data-loss machine: whoever
saves second overwrites whatever the first one added. Rather than make the
client track dirty entities, the server keeps a short history of book
snapshots and merges — the client only has to say which version it started
from.

Every entity carries a client-generated id, which is what makes this cheap:
adds, edits and deletes are all visible by comparing ids and values between
the base and what came in. Two people editing *the same* expense still
resolves last-write-wins; two people editing different things both survive,
which is the case that actually happens.
"""

from typing import TypeVar

from pydantic import BaseModel

from ledger.schemas import BookState

# Every id-keyed collection on a book. Settings and meta are merged per field.
COLLECTIONS = ("people", "accounts", "ledgers", "rules", "overrides", "expenses", "settlements")

M = TypeVar("M", bound=BaseModel)


def _by_id(items: list[M]) -> dict[str, M]:
    return {item.id: item for item in items}  # type: ignore[attr-defined]


def _merge_fields(base: M, mine: M, theirs: M) -> M:
    """Field-level: I win on the fields I actually changed, they keep the rest."""
    out = theirs.model_copy(deep=True)
    for name in type(mine).model_fields:
        if getattr(mine, name) != getattr(base, name):
            setattr(out, name, getattr(mine, name))
    return out


def merge_books(base: BookState, mine: BookState, theirs: BookState) -> BookState:
    """Fold my edits (base -> mine) onto the current server state (theirs).

    - an entity I added that they never saw is kept;
    - an entity I changed takes my version;
    - an entity I deleted goes, even if they touched it (delete wins);
    - anything I left alone keeps whatever they did to it.
    """
    out = theirs.model_copy(deep=True)

    for name in COLLECTIONS:
        base_by_id = _by_id(getattr(base, name))
        mine_by_id = _by_id(getattr(mine, name))
        merged = _by_id(getattr(theirs, name))

        for entity_id, item in mine_by_id.items():
            if entity_id not in base_by_id or base_by_id[entity_id] != item:
                merged[entity_id] = item  # I added or edited it
        for entity_id in base_by_id:
            if entity_id not in mine_by_id:
                merged.pop(entity_id, None)  # I deleted it

        setattr(out, name, list(merged.values()))

    out.settings = _merge_fields(base.settings, mine.settings, theirs.settings)
    out.meta = _merge_fields(base.meta, mine.meta, theirs.meta)
    return out
