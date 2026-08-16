from sqlmodel import Session, select

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
