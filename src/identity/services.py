"""Login-code issue/verify.

Security properties, copied from reathletic-agenda:
- codes come from `secrets`, compared with `compare_digest`
- 15-minute TTL, 5 wrong attempts burn the code
- an unknown address gets the identical response (no account enumeration)
- a failed email send is swallowed — the response never leaks existence
"""

import logging
import secrets
from datetime import timedelta
from uuid import UUID

from sqlmodel import Session, select

from core.email import send_email
from core.http import AuthenticationError
from core.utils import ensure_utc, utcnow
from identity.models import EmailVerification, User

logger = logging.getLogger(__name__)

TTL_MINUTES = 15
MAX_ATTEMPTS = 5


class EmailVerificationService:
    def __init__(self, session: Session):
        self.session = session

    def issue(self, email: str) -> EmailVerification:
        verification = EmailVerification(
            email=email,
            code=f"{secrets.randbelow(1_000_000):06d}",
            expires_at=utcnow() + timedelta(minutes=TTL_MINUTES),
        )
        self.session.add(verification)
        self.session.commit()
        self.session.refresh(verification)
        return verification

    def consume(self, verification_id: UUID, code: str) -> EmailVerification:
        verification = self.session.get(EmailVerification, verification_id)
        if not verification or verification.consumed_at is not None:
            raise ValueError("Verification not found. Please request a new code.")
        if ensure_utc(verification.expires_at) < utcnow():
            raise ValueError("This code has expired. Please request a new one.")
        if verification.attempts >= MAX_ATTEMPTS:
            raise ValueError("Too many attempts. Please request a new code.")
        if not secrets.compare_digest(verification.code, code.strip()):
            verification.attempts += 1
            self.session.add(verification)
            self.session.commit()
            raise ValueError("Incorrect code. Please check your email and try again.")
        verification.consumed_at = utcnow()
        self.session.add(verification)
        self.session.commit()
        return verification


class UserService:
    def __init__(self, session: Session):
        self.session = session

    def get_user_by_id(self, user_id: UUID) -> User | None:
        return self.session.get(User, user_id)

    def get_user_by_email(self, email: str) -> User | None:
        return self.session.exec(select(User).where(User.email == email)).first()


class LoginCodeService:
    def __init__(self, session: Session):
        self.session = session
        self.verifications = EmailVerificationService(session)
        self.users = UserService(session)

    def request(self, email: str) -> EmailVerification:
        verification = self.verifications.issue(email.strip().lower())
        user = self.users.get_user_by_email(verification.email)
        if user and user.is_active:
            try:
                send_email(
                    to=user.email,
                    subject="Your Piggy sign-in code",
                    body=(
                        f"Hello {user.name},\n\n"
                        f"Your sign-in code is: {verification.code}\n\n"
                        f"It is valid for {TTL_MINUTES} minutes. If you didn't ask for it, ignore this email."
                    ),
                )
            except Exception:
                # Never leak existence: the request still succeeds. send_email
                # has already logged why it failed, so all that is left to add
                # is the way back in while the mail path is broken.
                logger.warning(
                    "sign-in code for %s was issued but not emailed — read it with `manage login-code --email %s`",
                    user.email,
                    user.email,
                )
        return verification

    def verify(self, verification_id: UUID, code: str) -> User:
        try:
            verification = self.verifications.consume(verification_id, code)
        except ValueError as exc:
            raise AuthenticationError(str(exc)) from exc
        user = self.users.get_user_by_email(verification.email)
        if not user or not user.is_active:
            raise AuthenticationError("Invalid or expired code.")
        return user
