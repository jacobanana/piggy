"""The three-way merge, at the level it has to be right: no silent losses."""

from ledger.merge import merge_books
from ledger.schemas import BookState, ExpenseState, LedgerState, PersonState

LEA = PersonState(id="per_lea", name="Léa", emoji="🐰", color="#5A67E8")
MARC = PersonState(id="per_marc", name="Marc", emoji="🦊", color="#3EA7E8")
HOME = LedgerState(id="led_home", name="Home", emoji="🏠", kind="household", currency="CHF")


def expense(eid: str, name: str, amount: float = 10.0) -> ExpenseState:
    return ExpenseState(
        id=eid,
        ledgerId="led_home",
        name=name,
        emoji="🛒",
        amount=amount,
        currency="CHF",
        date="2026-08-01",
        accountId="acc_lea",
    )


def book(*expenses: ExpenseState, people: list[PersonState] | None = None) -> BookState:
    return BookState(
        people=people if people is not None else [LEA, MARC],
        ledgers=[HOME],
        expenses=list(expenses),
    )


def ids(state: BookState) -> set[str]:
    return {e.id for e in state.expenses}


def test_both_additions_survive():
    """The case that actually happens: two people add different expenses."""
    base = book(expense("e1", "Rent"))
    mine = book(expense("e1", "Rent"), expense("e2", "Coffee"))
    theirs = book(expense("e1", "Rent"), expense("e3", "Train"))

    assert ids(merge_books(base, mine, theirs)) == {"e1", "e2", "e3"}


def test_my_edit_does_not_drop_their_addition():
    base = book(expense("e1", "Rent", 1200))
    mine = book(expense("e1", "Rent", 1250))
    theirs = book(expense("e1", "Rent", 1200), expense("e2", "Coffee"))

    merged = merge_books(base, mine, theirs)
    assert ids(merged) == {"e1", "e2"}
    assert next(e for e in merged.expenses if e.id == "e1").amount == 1250


def test_their_edit_survives_where_i_did_not_touch():
    base = book(expense("e1", "Rent", 1200), expense("e2", "Coffee", 4))
    mine = book(expense("e1", "Rent", 1250), expense("e2", "Coffee", 4))
    theirs = book(expense("e1", "Rent", 1200), expense("e2", "Coffee", 5))

    merged = merge_books(base, mine, theirs)
    assert next(e for e in merged.expenses if e.id == "e1").amount == 1250
    assert next(e for e in merged.expenses if e.id == "e2").amount == 5


def test_my_delete_wins_over_their_edit():
    base = book(expense("e1", "Rent"), expense("e2", "Coffee"))
    mine = book(expense("e1", "Rent"))
    theirs = book(expense("e1", "Rent"), expense("e2", "Coffee", 99))

    assert ids(merge_books(base, mine, theirs)) == {"e1"}


def test_their_delete_stands_when_i_did_not_touch_it():
    base = book(expense("e1", "Rent"), expense("e2", "Coffee"))
    mine = book(expense("e1", "Rent"), expense("e2", "Coffee"))
    theirs = book(expense("e1", "Rent"))

    assert ids(merge_books(base, mine, theirs)) == {"e1"}


def test_people_added_on_both_sides_both_land():
    """Growing past two people from two devices at once."""
    base = book(people=[LEA])
    mine = book(people=[LEA, MARC])
    sam = PersonState(id="per_sam", name="Sam", emoji="🐻", color="#17B39A")
    theirs = book(people=[LEA, sam])

    assert {p.id for p in merge_books(base, mine, theirs).people} == {"per_lea", "per_marc", "per_sam"}


def test_settings_merge_per_field():
    base = book()
    mine = book()
    theirs = book()
    base.settings.theme = "blueberry"
    mine.settings.theme = "citrus"  # I changed the theme
    theirs.settings.theme = "blueberry"
    theirs.settings.baseCurrency = "EUR"  # they changed the currency

    merged = merge_books(base, mine, theirs)
    assert merged.settings.theme == "citrus"
    assert merged.settings.baseCurrency == "EUR"


def test_untouched_book_is_unchanged():
    base = book(expense("e1", "Rent"))
    theirs = book(expense("e1", "Rent"), expense("e2", "Coffee"))

    assert ids(merge_books(base, base.model_copy(deep=True), theirs)) == {"e1", "e2"}
