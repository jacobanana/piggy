from sqlmodel import Session, select

from core.config import get_settings
from identity.models import EmailVerification, User, UserRole


def make_user(session: Session, email: str = "lea@example.com", role: UserRole = UserRole.member) -> User:
    user = User(email=email, name="Léa", role=role)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def latest_code(session: Session, email: str) -> tuple[str, str]:
    v = session.exec(
        select(EmailVerification).where(EmailVerification.email == email).order_by(EmailVerification.created_at.desc())  # type: ignore[attr-defined]
    ).first()
    assert v is not None
    return str(v.id), v.code


def sign_in(client, session: Session, email: str) -> dict:
    resp = client.post("/api/auth/code/request", json={"email": email})
    assert resp.status_code == 202
    verification_id, code = latest_code(session, email)
    resp = client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": code})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_full_login_flow(client, session):
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    assert tokens["token_type"] == "bearer"
    assert tokens["user"]["email"] == "lea@example.com"

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert me.status_code == 200
    assert me.json()["email"] == "lea@example.com"


def test_unknown_address_gets_identical_response(client, session):
    resp = client.post("/api/auth/code/request", json={"email": "nobody@example.com"})
    assert resp.status_code == 202
    assert "verification_id" in resp.json()
    # ... but the code signs nobody in
    verification_id, code = latest_code(session, "nobody@example.com")
    resp = client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": code})
    assert resp.status_code == 401


def test_wrong_code_burns_attempts(client, session):
    make_user(session)
    client.post("/api/auth/code/request", json={"email": "lea@example.com"})
    verification_id, code = latest_code(session, "lea@example.com")
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        resp = client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": wrong})
        assert resp.status_code == 401
    # correct code now refused: too many attempts
    resp = client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": code})
    assert resp.status_code == 401
    assert "attempts" in resp.json()["detail"].lower()


def test_code_is_single_use(client, session):
    make_user(session)
    client.post("/api/auth/code/request", json={"email": "lea@example.com"})
    verification_id, code = latest_code(session, "lea@example.com")
    assert (
        client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": code}).status_code == 200
    )
    assert (
        client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": code}).status_code == 401
    )


def test_refresh_rotates_tokens(client, session):
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    resp = client.post("/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert resp.status_code == 200
    assert resp.json()["access_token"]


def test_refresh_token_is_not_a_session(client, session):
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tokens['refresh_token']}"})
    assert resp.status_code == 401


def test_deactivated_user_is_refused(client, session):
    user = make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    user.is_active = False
    session.add(user)
    session.commit()
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert resp.status_code == 403


# --------------------------------------------------------------------------
# Making an account from the home page
# --------------------------------------------------------------------------


def test_signup_makes_an_account_and_signs_it_in(client, session):
    resp = client.post("/api/auth/signup", json={"email": "new@example.com", "name": "Newcomer"})
    assert resp.status_code == 202, resp.text

    verification_id, code = latest_code(session, "new@example.com")
    assert verification_id == resp.json()["verification_id"]
    tokens = client.post("/api/auth/code/verify", json={"verification_id": verification_id, "code": code})
    assert tokens.status_code == 200, tokens.text
    assert tokens.json()["user"]["name"] == "Newcomer"

    # And they land in a piggy bank of their own, not somebody else's.
    headers = {"Authorization": f"Bearer {tokens.json()['access_token']}"}
    assert client.get("/api/book", headers=headers).status_code == 200
    assert len(client.get("/api/books", headers=headers).json()) == 1


def test_signup_on_a_taken_address_says_nothing_and_makes_nothing(client, session):
    """Answering differently here would turn the form into an account oracle."""
    make_user(session, email="lea@example.com")

    resp = client.post("/api/auth/signup", json={"email": "lea@example.com", "name": "Impostor"})
    assert resp.status_code == 202

    leas = session.exec(select(User).where(User.email == "lea@example.com")).all()
    assert len(leas) == 1
    assert leas[0].name == "Léa"  # the name on the account is not overwritten


def test_signup_can_be_switched_off(client, session, monkeypatch):
    monkeypatch.setenv("OPEN_SIGNUP", "false")
    get_settings.cache_clear()
    try:
        resp = client.post("/api/auth/signup", json={"email": "nosy@example.com", "name": "Nosy"})
        assert resp.status_code == 403
        assert session.exec(select(User).where(User.email == "nosy@example.com")).first() is None
    finally:
        monkeypatch.delenv("OPEN_SIGNUP")
        get_settings.cache_clear()


def test_health_says_whether_the_door_is_open(client):
    assert client.get("/api/health").json() == {"status": "ok", "openSignup": True}


# --------------------------------------------------------------------------
# The profile: the name and face that follow an account into every book
# --------------------------------------------------------------------------


def test_profile_travels_with_the_account(client, session):
    """A face on the account, so a second piggy bank needn't be told who you are."""
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    assert tokens["user"]["emoji"] == "🙂"  # the face a new account is born with

    resp = client.patch("/api/auth/me", json={"name": "Léa B", "emoji": "🦊"}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Léa B"
    assert resp.json()["emoji"] == "🦊"

    me = client.get("/api/auth/me", headers=headers).json()
    assert (me["name"], me["emoji"]) == ("Léa B", "🦊")


def test_profile_edits_one_field_at_a_time(client, session):
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    assert client.patch("/api/auth/me", json={"emoji": "🐼"}, headers=headers).json()["name"] == "Léa"
    assert client.patch("/api/auth/me", json={"name": "Léa B"}, headers=headers).json()["emoji"] == "🐼"


def test_profile_refuses_a_blank_name_and_falls_back_on_a_blank_face(client, session):
    make_user(session)
    tokens = sign_in(client, session, "lea@example.com")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    assert client.patch("/api/auth/me", json={"name": "   "}, headers=headers).status_code == 400
    assert client.patch("/api/auth/me", json={"emoji": " "}, headers=headers).json()["emoji"] == "🙂"
    assert client.get("/api/auth/me", headers=headers).json()["name"] == "Léa"


def test_profile_is_yours_alone(client, session):
    make_user(session)
    assert client.patch("/api/auth/me", json={"name": "Nobody"}).status_code == 401
