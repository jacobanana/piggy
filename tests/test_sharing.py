"""Sharing a piggy bank: invites, membership, and two people writing at once."""

from sqlmodel import select

from identity.models import User
from ledger.models import (
    Account,
    Book,
    BookInvite,
    BookMember,
    BookSnapshot,
    Expense,
    Ledger,
    Person,
    Split,
)
from tests.test_auth import latest_code, make_user, sign_in


def auth(client, session, email: str) -> dict:
    make_user(session, email=email)
    tokens = sign_in(client, session, email)
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def book_with(client, headers, *names: str) -> tuple[str, dict]:
    """Create a book via the default endpoint and seed it with one ledger."""
    resp = client.get("/api/book", headers=headers)
    assert resp.status_code == 200
    state = resp.json()
    state["people"] = [{"id": f"per_{n.lower()}", "name": n, "emoji": "🙂", "color": "#5A67E8"} for n in names]
    state["accounts"] = [
        {
            "id": "acc_joint",
            "name": "Joint",
            "kind": "joint",
            "ownership": {f"per_{n.lower()}": 1 / len(names) for n in names},
        }
    ]
    state["ledgers"] = [
        {
            "id": "led_home",
            "name": "Home",
            "emoji": "🏠",
            "kind": "household",
            "currency": "CHF",
            "startDate": None,
            "endDate": None,
            "archived": False,
        }
    ]
    put = client.put("/api/book", json=state, headers={**headers, "If-Match": resp.headers["ETag"]})
    assert put.status_code == 200, put.text
    books = client.get("/api/books", headers=headers).json()
    return books[0]["id"], put.json()


def expense(eid: str, name: str, amount: float = 10.0) -> dict:
    return {
        "id": eid,
        "ledgerId": "led_home",
        "name": name,
        "emoji": "🛒",
        "amount": amount,
        "currency": "CHF",
        "fxRate": None,
        "date": "2026-08-01",
        "accountId": "acc_joint",
        "method": "card",
        "planned": False,
        "split": {"mode": "equal", "participants": [], "values": {}},
        "notes": "",
    }


def test_book_list_starts_with_the_default_book(client, session):
    headers = auth(client, session, "lea@example.com")
    client.get("/api/book", headers=headers)

    books = client.get("/api/books", headers=headers).json()
    assert len(books) == 1
    assert books[0]["role"] == "owner"
    assert books[0]["members"] == 1


def test_a_summary_counts_members_and_owners(client, session):
    """The switcher offers "leave" from these two — a book keeps one owner,
    so the only owner is offered "delete" instead of a refused request."""
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    alone = client.get("/api/books", headers=lea).json()[0]
    assert (alone["members"], alone["owners"], alone["role"]) == (1, 1, "owner")

    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    joined = client.post(f"/api/invites/{code}/accept", headers=marc).json()

    assert (joined["members"], joined["owners"], joined["role"]) == (2, 1, "member")
    shared = client.get("/api/books", headers=lea).json()[0]
    assert (shared["members"], shared["owners"]) == (2, 1)


def test_a_user_can_hold_several_books(client, session):
    headers = auth(client, session, "lea@example.com")
    client.get("/api/book", headers=headers)
    made = client.post("/api/books", json={"name": "Lisbon crew"}, headers=headers)
    assert made.status_code == 201, made.text

    names = {b["name"] for b in client.get("/api/books", headers=headers).json()}
    assert "Lisbon crew" in names and len(names) == 2


def test_invite_round_trip(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")

    invite = client.post(f"/api/books/{book_id}/invite", headers=lea)
    assert invite.status_code == 200, invite.text
    code = invite.json()["code"]

    marc = auth(client, session, "marc@example.com")
    preview = client.get(f"/api/invites/{code}", headers=marc).json()
    assert preview["bookName"] and preview["alreadyMember"] is False

    joined = client.post(f"/api/invites/{code}/accept", headers=marc)
    assert joined.status_code == 200, joined.text
    assert joined.json()["role"] == "member"

    members = client.get(f"/api/books/{book_id}/members", headers=lea).json()
    assert {m["email"] for m in members} == {"lea@example.com", "marc@example.com"}


def test_accepting_twice_is_a_no_op(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]

    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)
    again = client.post(f"/api/invites/{code}/accept", headers=marc)

    assert again.status_code == 200
    assert client.get(f"/api/books/{book_id}/members", headers=lea).json().__len__() == 2


def test_revoked_invite_is_refused(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    invite = client.post(f"/api/books/{book_id}/invite", headers=lea).json()
    client.delete(f"/api/books/{book_id}/invite", headers=lea)

    marc = auth(client, session, "marc@example.com")
    assert client.post(f"/api/invites/{invite['code']}/accept", headers=marc).status_code == 400
    assert client.get(f"/api/books/{book_id}/invite", headers=lea).json() is None


def test_a_book_has_one_link_and_it_is_its_own(client, session):
    """The share screen shows the link to the bank on screen, and only that."""
    lea = auth(client, session, "lea@example.com")
    flat, _ = book_with(client, lea, "Lea", "Marc")
    trip = client.post("/api/books", json={"name": "Lisbon"}, headers=lea).json()["id"]

    flat_code = client.post(f"/api/books/{flat}/invite", headers=lea).json()["code"]
    trip_code = client.post(f"/api/books/{trip}/invite", headers=lea).json()["code"]
    assert flat_code != trip_code

    # Pressing share again hands back the same link rather than quietly
    # leaving a second live code behind that nobody can see or revoke.
    assert client.post(f"/api/books/{flat}/invite", headers=lea).json()["code"] == flat_code
    assert client.get(f"/api/books/{flat}/invite", headers=lea).json()["code"] == flat_code
    assert client.get(f"/api/books/{trip}/invite", headers=lea).json()["code"] == trip_code

    # And the link opens the bank it was made for, not the other one.
    marc = auth(client, session, "marc@example.com")
    joined = client.post(f"/api/invites/{trip_code}/accept", headers=marc).json()
    assert joined["id"] == trip
    assert {b["id"] for b in client.get("/api/books", headers=marc).json()} == {trip}


def test_a_book_with_no_link_yet_has_none(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    assert client.get(f"/api/books/{book_id}/invite", headers=lea).json() is None


def test_non_member_cannot_see_a_book(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")

    nosy = auth(client, session, "nosy@example.com")
    assert client.get(f"/api/books/{book_id}", headers=nosy).status_code == 404
    assert client.get(f"/api/books/{book_id}/members", headers=nosy).status_code == 404


def test_member_cannot_mint_invites(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    assert client.post(f"/api/books/{book_id}/invite", headers=marc).status_code == 403


def test_claiming_a_person_links_the_account(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    claimed = client.put(f"/api/books/{book_id}/members/me/person", json={"personId": "per_marc"}, headers=marc)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["personId"] == "per_marc"


def test_two_people_cannot_claim_the_same_person(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    client.put(f"/api/books/{book_id}/members/me/person", json={"personId": "per_marc"}, headers=lea)
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    clash = client.put(f"/api/books/{book_id}/members/me/person", json={"personId": "per_marc"}, headers=marc)
    assert clash.status_code == 400


def test_concurrent_edits_both_survive(client, session):
    """The whole reason the merge exists: nobody's expense disappears."""
    lea = auth(client, session, "lea@example.com")
    book_id, state = book_with(client, lea, "Lea", "Marc")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    # Both load the same version, then both save without seeing each other.
    lea_read = client.get(f"/api/books/{book_id}", headers=lea)
    marc_read = client.get(f"/api/books/{book_id}", headers=marc)
    version = lea_read.headers["ETag"]
    assert marc_read.headers["ETag"] == version

    lea_state = lea_read.json()
    lea_state["expenses"] = [expense("e_lea", "Groceries")]
    first = client.put(f"/api/books/{book_id}", json=lea_state, headers={**lea, "If-Match": version})
    assert first.status_code == 200, first.text

    marc_state = marc_read.json()
    marc_state["expenses"] = [expense("e_marc", "Train tickets")]
    second = client.put(f"/api/books/{book_id}", json=marc_state, headers={**marc, "If-Match": version})
    assert second.status_code == 200, second.text

    assert {e["id"] for e in second.json()["expenses"]} == {"e_lea", "e_marc"}
    final = client.get(f"/api/books/{book_id}", headers=lea).json()
    assert {e["id"] for e in final["expenses"]} == {"e_lea", "e_marc"}


def test_version_advances_on_every_write(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")

    first = client.get(f"/api/books/{book_id}", headers=lea)
    state = first.json()
    state["expenses"] = [expense("e1", "Rent")]
    after = client.put(f"/api/books/{book_id}", json=state, headers={**lea, "If-Match": first.headers["ETag"]})

    assert int(after.headers["ETag"].strip('"')) > int(first.headers["ETag"].strip('"'))


def test_a_write_with_no_if_match_still_works(client, session):
    """Any client that never read a version keeps working, overwrite semantics."""
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")

    state = client.get(f"/api/books/{book_id}", headers=lea).json()
    state["expenses"] = [expense("e1", "Rent")]
    assert client.put(f"/api/books/{book_id}", json=state, headers=lea).status_code == 200


def test_a_member_can_leave(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    marc_id = client.post(f"/api/invites/{code}/accept", headers=marc)
    assert marc_id.status_code == 200

    me = [m for m in client.get(f"/api/books/{book_id}/members", headers=marc).json() if m["isMe"]][0]
    assert client.delete(f"/api/books/{book_id}/members/{me['userId']}", headers=marc).status_code == 204
    assert client.get(f"/api/books/{book_id}", headers=marc).status_code == 404


def test_the_last_owner_cannot_be_removed(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    me = client.get(f"/api/books/{book_id}/members", headers=lea).json()[0]

    assert client.delete(f"/api/books/{book_id}/members/{me['userId']}", headers=lea).status_code == 400


# --------------------------------------------------------------------------
# Deleting a piggy bank
# --------------------------------------------------------------------------


def test_an_owner_can_delete_a_book_and_nothing_of_it_is_left(client, session):
    """The only owner's way out — leaving is refused, so this has to work."""
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    read = client.get(f"/api/books/{book_id}", headers=lea)
    state = read.json()
    state["expenses"] = [expense("e1", "Groceries")]
    client.put(f"/api/books/{book_id}", json=state, headers={**lea, "If-Match": read.headers["ETag"]})
    client.post(f"/api/books/{book_id}/invite", headers=lea)

    assert client.delete(f"/api/books/{book_id}", headers=lea).status_code == 204

    assert client.get(f"/api/books/{book_id}", headers=lea).status_code == 404
    assert client.get("/api/books", headers=lea).json() == []
    for model in (Book, BookInvite, BookMember, BookSnapshot, Person, Account, Ledger, Expense, Split):
        assert session.exec(select(model)).all() == [], f"{model.__name__} rows outlived the book"


def test_deleting_takes_the_book_away_from_everyone_in_it(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    assert client.delete(f"/api/books/{book_id}", headers=lea).status_code == 204

    assert client.get("/api/books", headers=marc).json() == []
    assert client.get(f"/api/books/{book_id}", headers=marc).status_code == 404
    # The link it was shared with dies with it rather than 500ing on a ghost.
    assert client.get(f"/api/invites/{code}", headers=marc).status_code == 404


def test_only_an_owner_can_delete_a_book(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    assert client.delete(f"/api/books/{book_id}", headers=marc).status_code == 403
    # And somebody with no business here learns nothing either way.
    nosy = auth(client, session, "nosy@example.com")
    assert client.delete(f"/api/books/{book_id}", headers=nosy).status_code == 404
    assert client.get(f"/api/books/{book_id}", headers=lea).status_code == 200


def test_deleting_one_book_leaves_the_others_standing(client, session):
    lea = auth(client, session, "lea@example.com")
    flat, _ = book_with(client, lea, "Lea", "Marc")
    trip = client.post("/api/books", json={"name": "Lisbon"}, headers=lea).json()["id"]

    assert client.delete(f"/api/books/{flat}", headers=lea).status_code == 204

    assert [b["id"] for b in client.get("/api/books", headers=lea).json()] == [trip]
    assert client.get(f"/api/books/{trip}", headers=lea).status_code == 200


# --------------------------------------------------------------------------
# Arriving on a link with no account yet
# --------------------------------------------------------------------------


def test_an_invite_code_is_a_front_door_for_somebody_with_no_account(client, session):
    """The whole point of a link: hand it to someone who has never been here."""
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]

    claim = client.post(f"/api/invites/{code}/claim", json={"email": "marc@example.com"})
    assert claim.status_code == 202, claim.text

    verification_id, login_code = latest_code(session, "marc@example.com")
    assert verification_id == claim.json()["verification_id"]
    tokens = client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": login_code})
    assert tokens.status_code == 200, tokens.text

    marc = {"Authorization": f"Bearer {tokens.json()['access_token']}"}
    joined = client.post(f"/api/invites/{code}/accept", headers=marc)
    assert joined.status_code == 200
    assert joined.json()["id"] == book_id


def test_claiming_an_existing_account_does_not_make_a_second(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    code = client.post(f"/api/books/{book_id}/invite", headers=lea).json()["code"]
    make_user(session, email="marc@example.com")

    assert client.post(f"/api/invites/{code}/claim", json={"email": "marc@example.com"}).status_code == 202
    marcs = session.exec(select(User).where(User.email == "marc@example.com")).all()
    assert len(marcs) == 1


def test_no_code_no_account(client, session):
    """Without a live code there is no sign-up — the only gate there is."""
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    invite = client.post(f"/api/books/{book_id}/invite", headers=lea).json()

    assert client.post("/api/invites/NOSUCH12/claim", json={"email": "nosy@example.com"}).status_code == 404
    client.delete(f"/api/books/{book_id}/invite", headers=lea)
    assert client.post(f"/api/invites/{invite['code']}/claim", json={"email": "nosy@example.com"}).status_code == 400
    assert session.exec(select(User).where(User.email == "nosy@example.com")).first() is None
