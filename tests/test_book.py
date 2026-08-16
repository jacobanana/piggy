"""Round-trip: a frontend export PUT to the API comes back identical in substance."""

from tests.test_auth import make_user, sign_in

SAMPLE_BOOK = {
    "schemaVersion": 1,
    "meta": {
        "appName": "Our Piggy",
        "createdAt": "2025-01-01T00:00:00+00:00",
        "updatedAt": "2025-06-01T00:00:00+00:00",
    },
    "settings": {
        "theme": "citrus",
        "baseCurrency": "CHF",
        "currencies": ["CHF", "EUR"],
        "rates": {"CHF": 1, "EUR": 0.94, "USD": 0.81},
        "ratesUpdatedAt": None,
        "lastPayMethod": "twint",
    },
    "people": [
        {"id": "per_lea", "name": "Léa", "emoji": "🐰", "color": "#5A67E8"},
        {"id": "per_marc", "name": "Marc", "emoji": "🦊", "color": "#3EA7E8"},
    ],
    "accounts": [
        {"id": "acc_lea", "name": "Léa's money", "kind": "personal", "ownership": {"per_lea": 1}},
        {"id": "acc_marc", "name": "Marc's money", "kind": "personal", "ownership": {"per_marc": 1}},
        {"id": "acc_joint", "name": "Joint account", "kind": "joint", "ownership": {"per_lea": 0.5, "per_marc": 0.5}},
    ],
    "ledgers": [
        {
            "id": "led_home",
            "name": "Home",
            "emoji": "🏠",
            "kind": "household",
            "currency": "CHF",
            "startDate": None,
            "endDate": None,
            "archived": False,
        },
        {
            "id": "led_trip",
            "name": "Lisbon",
            "emoji": "✈️",
            "kind": "trip",
            "currency": "EUR",
            "startDate": "2025-05-01",
            "endDate": "2025-05-08",
            "archived": False,
        },
    ],
    "rules": [
        {
            "id": "rule_rent",
            "ledgerId": "led_home",
            "name": "Rent",
            "emoji": "🏠",
            "amount": 1850.0,
            "currency": "CHF",
            "frequency": "monthly",
            "dueDay": 1,
            "startMonth": "2025-01",
            "endMonth": None,
            "accountId": "acc_joint",
            "method": "direct-debit",
            "split": {"mode": "equal", "participants": ["per_lea", "per_marc"], "values": {}},
            "active": True,
            "notes": "",
        },
    ],
    "overrides": [
        {
            "id": "ovr_1",
            "ruleId": "rule_rent",
            "period": "2025-03",
            "amount": 1900.0,
            "currency": None,
            "accountId": None,
            "date": None,
            "split": None,
            "skipped": False,
        },
    ],
    "expenses": [
        {
            "id": "exp_1",
            "ledgerId": "led_home",
            "name": "Groceries",
            "emoji": "🛒",
            "amount": 84.35,
            "currency": "CHF",
            "fxRate": 1.0,
            "date": "2025-06-10",
            "accountId": "acc_lea",
            "method": "card",
            "planned": False,
            "split": {
                "mode": "shares",
                "participants": ["per_lea", "per_marc"],
                "values": {"per_lea": 2, "per_marc": 1},
            },
            "notes": "Coop",
        },
        {
            "id": "exp_2",
            "ledgerId": "led_trip",
            "name": "Hotel",
            "emoji": "🏨",
            "amount": 420.0,
            "currency": "EUR",
            "fxRate": 0.95,
            "date": "2025-05-02",
            "accountId": "acc_marc",
            "method": "card",
            "planned": True,
            "split": {"mode": "equal", "participants": ["per_lea", "per_marc"], "values": {}},
            "notes": "",
        },
    ],
    "settlements": [
        {
            "id": "set_1",
            "ledgerId": "led_home",
            "date": "2025-06-15",
            "fromPersonId": "per_marc",
            "toPersonId": "per_lea",
            "amount": 28.1,
            "currency": "CHF",
            "fxRate": 1.0,
            "method": "twint",
            "note": "Settle up",
        },
    ],
}


def auth_headers(client, session) -> dict:
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def test_book_requires_auth(client):
    assert client.get("/api/book").status_code == 401


def test_new_user_gets_an_empty_book(client, session):
    headers = auth_headers(client, session)
    resp = client.get("/api/book", headers=headers)
    assert resp.status_code == 200
    book = resp.json()
    assert book["people"] == []
    assert book["meta"]["appName"] == "Piggy"


def test_put_then_get_round_trips(client, session):
    headers = auth_headers(client, session)
    put = client.put("/api/book", json=SAMPLE_BOOK, headers=headers)
    assert put.status_code == 200, put.text

    got = client.get("/api/book", headers=headers).json()

    assert got["meta"]["appName"] == "Our Piggy"
    assert got["settings"]["theme"] == "citrus"
    assert got["settings"]["lastPayMethod"] == "twint"
    assert sorted(got["settings"]["currencies"]) == ["CHF", "EUR"]
    assert got["settings"]["rates"] == {"CHF": 1.0, "EUR": 0.94, "USD": 0.81}

    assert {p["id"] for p in got["people"]} == {"per_lea", "per_marc"}
    joint = next(a for a in got["accounts"] if a["id"] == "acc_joint")
    assert joint["ownership"] == {"per_lea": 0.5, "per_marc": 0.5}

    assert {ledger["id"] for ledger in got["ledgers"]} == {"led_home", "led_trip"}
    trip = next(ledger for ledger in got["ledgers"] if ledger["id"] == "led_trip")
    assert trip["startDate"] == "2025-05-01"

    rule = got["rules"][0]
    assert rule["amount"] == 1850.0
    assert sorted(rule["split"]["participants"]) == ["per_lea", "per_marc"]

    override = got["overrides"][0]
    assert override["amount"] == 1900.0
    assert override["split"] is None

    groceries = next(e for e in got["expenses"] if e["id"] == "exp_1")
    assert groceries["split"]["mode"] == "shares"
    assert groceries["split"]["values"] == {"per_lea": 2.0, "per_marc": 1.0}
    hotel = next(e for e in got["expenses"] if e["id"] == "exp_2")
    assert hotel["planned"] is True

    assert got["settlements"][0]["fromPersonId"] == "per_marc"


def test_put_replaces_rather_than_merges(client, session):
    headers = auth_headers(client, session)
    client.put("/api/book", json=SAMPLE_BOOK, headers=headers)

    smaller = {**SAMPLE_BOOK, "expenses": [], "settlements": [], "overrides": [], "rules": []}
    client.put("/api/book", json=smaller, headers=headers)

    got = client.get("/api/book", headers=headers).json()
    assert got["expenses"] == []
    assert got["rules"] == []
    assert len(got["people"]) == 2
