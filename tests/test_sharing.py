"""Sharing a piggy bank: invites, membership, and two people writing at once."""

from tests.test_auth import make_user, sign_in


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

    invite = client.post(f"/api/books/{book_id}/invites", headers=lea)
    assert invite.status_code == 201, invite.text
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
    code = client.post(f"/api/books/{book_id}/invites", headers=lea).json()["code"]

    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)
    again = client.post(f"/api/invites/{code}/accept", headers=marc)

    assert again.status_code == 200
    assert client.get(f"/api/books/{book_id}/members", headers=lea).json().__len__() == 2


def test_revoked_invite_is_refused(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    invite = client.post(f"/api/books/{book_id}/invites", headers=lea).json()
    client.delete(f"/api/books/{book_id}/invites/{invite['id']}", headers=lea)

    marc = auth(client, session, "marc@example.com")
    assert client.post(f"/api/invites/{invite['code']}/accept", headers=marc).status_code == 400


def test_non_member_cannot_see_a_book(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")

    nosy = auth(client, session, "nosy@example.com")
    assert client.get(f"/api/books/{book_id}", headers=nosy).status_code == 404
    assert client.get(f"/api/books/{book_id}/members", headers=nosy).status_code == 404


def test_member_cannot_mint_invites(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea")
    code = client.post(f"/api/books/{book_id}/invites", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    assert client.post(f"/api/books/{book_id}/invites", headers=marc).status_code == 403


def test_claiming_a_person_links_the_account(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    code = client.post(f"/api/books/{book_id}/invites", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    claimed = client.put(f"/api/books/{book_id}/members/me/person", json={"personId": "per_marc"}, headers=marc)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["personId"] == "per_marc"


def test_two_people_cannot_claim_the_same_person(client, session):
    lea = auth(client, session, "lea@example.com")
    book_id, _ = book_with(client, lea, "Lea", "Marc")
    client.put(f"/api/books/{book_id}/members/me/person", json={"personId": "per_marc"}, headers=lea)
    code = client.post(f"/api/books/{book_id}/invites", headers=lea).json()["code"]
    marc = auth(client, session, "marc@example.com")
    client.post(f"/api/invites/{code}/accept", headers=marc)

    clash = client.put(f"/api/books/{book_id}/members/me/person", json={"personId": "per_marc"}, headers=marc)
    assert clash.status_code == 400


def test_concurrent_edits_both_survive(client, session):
    """The whole reason the merge exists: nobody's expense disappears."""
    lea = auth(client, session, "lea@example.com")
    book_id, state = book_with(client, lea, "Lea", "Marc")
    code = client.post(f"/api/books/{book_id}/invites", headers=lea).json()["code"]
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
    code = client.post(f"/api/books/{book_id}/invites", headers=lea).json()["code"]
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
