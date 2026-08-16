"""The user CLI, driven through its argparse entry point."""

import pytest
from sqlmodel import Session, select

import manage
from identity.models import User, UserRole


def run(argv: list[str]) -> None:
    args = manage.build_parser().parse_args(argv)
    args.func(args)


def test_create_and_list(session: Session, capsys):
    run(["create", "--email", "adri@example.com", "--name", "Adri", "--role", "admin"])
    run(["list"])
    out = capsys.readouterr().out
    assert "adri@example.com" in out
    assert "admin" in out

    user = session.exec(select(User).where(User.email == "adri@example.com")).first()
    assert user is not None
    assert user.role == UserRole.admin


def test_create_refuses_duplicates(session: Session):
    run(["create", "--email", "adri@example.com", "--name", "Adri"])
    with pytest.raises(SystemExit):
        run(["create", "--email", "adri@example.com", "--name", "Again"])


def test_set_role_and_deactivate(session: Session):
    run(["create", "--email", "adri@example.com", "--name", "Adri"])
    run(["set-role", "--email", "adri@example.com", "--role", "admin"])
    run(["deactivate", "--email", "adri@example.com"])

    user = session.exec(select(User).where(User.email == "adri@example.com")).first()
    session.refresh(user)
    assert user.role == UserRole.admin
    assert user.is_active is False


def test_login_code_break_glass(client, session: Session, capsys):
    run(["create", "--email", "adri@example.com", "--name", "Adri"])
    client.post("/api/auth/code/request", json={"email": "adri@example.com"})
    capsys.readouterr()  # drop the create/email chatter — we want login-code's output alone
    run(["login-code", "--email", "adri@example.com"])
    out = capsys.readouterr().out
    code = out.strip().split()[0]
    assert len(code) == 6
    assert code.isdigit()


def test_login_code_without_pending_exits(session: Session):
    with pytest.raises(SystemExit):
        run(["login-code", "--email", "ghost@example.com"])
