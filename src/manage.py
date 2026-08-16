"""Command-line user administration.

    uv run manage list
    uv run manage create --email you@example.com --name "You" --role admin
    docker compose exec backend manage list

Everything here is deliberately available without signing in, because one of
its jobs is to get you back in when you cannot: ``login-code`` prints the code
that was just issued for an address, so a mail outage is not a lockout. That
makes shell access equivalent to admin access — which it already was, since
the database sits behind the same door.
"""

import argparse
import sys

from sqlmodel import Session, col, select

from core.utils import utcnow
from database.connection import engine
from identity.models import EmailVerification, User, UserRole

ROLE_CHOICES = [role.value for role in UserRole]


def _find(session: Session, email: str) -> User:
    user = session.exec(select(User).where(User.email == email)).first()
    if user is None:
        sys.exit(f"No user with email {email}")
    return user


def _describe(user: User) -> str:
    state = "active" if user.is_active else "inactive"
    return f"{user.email:40} {user.role.value:8} {state:9} {user.name}"


def cmd_list(args: argparse.Namespace) -> None:
    with Session(engine) as session:
        statement = select(User)
        if args.role:
            statement = statement.where(User.role == UserRole(args.role))
        if not args.all:
            statement = statement.where(User.is_active == True)  # noqa: E712
        users = session.exec(statement.order_by(col(User.role), col(User.name))).all()
        for user in users:
            print(_describe(user))
        print(f"\n{len(users)} user(s)")


def cmd_create(args: argparse.Namespace) -> None:
    with Session(engine) as session:
        email = args.email.strip().lower()
        existing = session.exec(select(User).where(User.email == email)).first()
        if existing is not None:
            sys.exit(f"{email} already exists: {_describe(existing)}")
        user = User(email=email, name=args.name, role=UserRole(args.role), is_active=True)
        session.add(user)
        session.commit()
        session.refresh(user)
        print(f"Created {_describe(user)}")


def cmd_set_role(args: argparse.Namespace) -> None:
    with Session(engine) as session:
        user = _find(session, args.email)
        user.role = UserRole(args.role)
        user.updated_at = utcnow()
        session.add(user)
        session.commit()
        session.refresh(user)
        print(f"Updated {_describe(user)}")


def cmd_set_email(args: argparse.Namespace) -> None:
    with Session(engine) as session:
        user = _find(session, args.email)
        new_email = args.new_email.strip().lower()
        if new_email == user.email:
            sys.exit(f"{user.email} already has that address")
        taken = session.exec(select(User).where(User.email == new_email)).first()
        if taken is not None:
            sys.exit(f"{new_email} is already taken: {_describe(taken)}")
        was = user.email
        user.email = new_email
        user.updated_at = utcnow()
        session.add(user)
        session.commit()
        session.refresh(user)
        print(f"Moved {was} -> {_describe(user)}")


def _set_active(email: str, is_active: bool) -> None:
    with Session(engine) as session:
        user = _find(session, email)
        user.is_active = is_active
        user.updated_at = utcnow()
        session.add(user)
        session.commit()
        session.refresh(user)
        print(f"Updated {_describe(user)}")


def cmd_activate(args: argparse.Namespace) -> None:
    _set_active(args.email, True)


def cmd_deactivate(args: argparse.Namespace) -> None:
    _set_active(args.email, False)


def cmd_logout(args: argparse.Namespace) -> None:
    """Invalidate every session of a user — tokens issued before now are refused."""
    with Session(engine) as session:
        user = _find(session, args.email)
        user.sessions_invalidated_at = utcnow()
        user.updated_at = utcnow()
        session.add(user)
        session.commit()
        print(f"Signed out everywhere: {_describe(user)}")


def cmd_login_code(args: argparse.Namespace) -> None:
    """Print the sign-in code most recently issued for an address.

    Break-glass, for when the email cannot be read: request a code from the
    login page as usual, then run this to see what was sent and type it in.
    """
    with Session(engine) as session:
        verification = session.exec(
            select(EmailVerification)
            .where(
                EmailVerification.email == args.email,
                col(EmailVerification.consumed_at).is_(None),
                col(EmailVerification.expires_at) > utcnow(),
            )
            .order_by(col(EmailVerification.created_at).desc())
        ).first()

        if verification is None:
            sys.exit(f"No pending sign-in code for {args.email}. Request one from the login page, then run this again.")

        remaining = int((verification.expires_at - utcnow()).total_seconds() // 60)
        print(f"{verification.code}  (valid for ~{remaining} more minute(s))")

        user = session.exec(select(User).where(User.email == args.email)).first()
        if user is None or not user.is_active:
            reason = "has no account" if user is None else "is deactivated"
            print(f"WARNING: {args.email} {reason} — this code will not sign anyone in.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="manage", description="User administration for Piggy.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List users")
    list_parser.add_argument("--role", choices=ROLE_CHOICES, help="Only this role")
    list_parser.add_argument("--all", action="store_true", help="Include deactivated users")
    list_parser.set_defaults(func=cmd_list)

    create_parser = subparsers.add_parser("create", help="Create a user")
    create_parser.add_argument("--email", required=True)
    create_parser.add_argument("--name", required=True)
    create_parser.add_argument("--role", choices=ROLE_CHOICES, default=UserRole.member.value)
    create_parser.set_defaults(func=cmd_create)

    role_parser = subparsers.add_parser("set-role", help="Change a user's role")
    role_parser.add_argument("--email", required=True)
    role_parser.add_argument("--role", choices=ROLE_CHOICES, required=True)
    role_parser.set_defaults(func=cmd_set_role)

    email_parser = subparsers.add_parser("set-email", help="Move a user to a different address")
    email_parser.add_argument("--email", required=True, help="The address they are on now")
    email_parser.add_argument("--new-email", required=True, help="The address to move them to")
    email_parser.set_defaults(func=cmd_set_email)

    activate_parser = subparsers.add_parser("activate", help="Reactivate a user")
    activate_parser.add_argument("--email", required=True)
    activate_parser.set_defaults(func=cmd_activate)

    deactivate_parser = subparsers.add_parser("deactivate", help="Deactivate a user")
    deactivate_parser.add_argument("--email", required=True)
    deactivate_parser.set_defaults(func=cmd_deactivate)

    logout_parser = subparsers.add_parser("logout", help="Sign a user out everywhere")
    logout_parser.add_argument("--email", required=True)
    logout_parser.set_defaults(func=cmd_logout)

    code_parser = subparsers.add_parser("login-code", help="Show the pending sign-in code for an address")
    code_parser.add_argument("--email", required=True)
    code_parser.set_defaults(func=cmd_login_code)

    return parser


def main() -> None:
    # The engine echoes SQL in development, which would bury the one line this
    # tool exists to print — a sign-in code read under pressure.
    engine.echo = False
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
