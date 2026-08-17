"""Application settings.

Smart defaults for development; production overrides via environment
variables or .env. The validators fail closed: the app refuses to boot in
production with the shared dev secret or with dev auth enabled.
"""

from functools import lru_cache
from typing import Any, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    environment: Literal["development", "production", "test"] = Field(default="development")

    database_url: str = Field(
        default="postgresql://piggy_user:piggy_dev_password@localhost:5432/piggy",
        description="SQLAlchemy database URL (Postgres).",
    )

    # --- auth ---------------------------------------------------------------
    jwt_secret_key: str = Field(default="dev-secret-key-CHANGE-IN-PRODUCTION")
    jwt_algorithm: str = Field(default="HS256")
    access_token_expire_minutes: int = Field(default=60 * 24)
    refresh_token_expire_days: int = Field(default=30)
    # Dev-only password-less login endpoints (list users, sign in as one).
    dev_auth_enabled: bool = Field(default=False)
    # Whether the home page offers "Create an account". Off means the only
    # ways in are an invite link and `manage create` — set it that way on a
    # Piggy that is only ever meant to hold your own household.
    open_signup: bool = Field(default=True)

    # --- email (login codes) ------------------------------------------------
    # Both empty -> codes are printed to the server log instead of emailed.
    smtp_host: str = Field(default="")
    smtp_port: int = Field(default=587)
    smtp_username: str = Field(default="")
    smtp_password: str = Field(default="")
    email_sender: str = Field(default="piggy@localhost")
    # A relay that accepts the connection and then never answers would
    # otherwise hang the sign-in request until the client gives up.
    smtp_timeout: int = Field(default=15)
    # Emits the SMTP conversation at DEBUG. Never on by default: the dialogue
    # contains the base64 AUTH exchange, which is the password in clear.
    smtp_debug: bool = Field(default=False)

    # --- logging ------------------------------------------------------------
    log_level: str = Field(default="INFO")

    # --- frontend -----------------------------------------------------------
    frontend_url: str = Field(default="http://localhost:5173")
    frontend_dist_dir: str = Field(default="frontend/dist")

    @field_validator("jwt_secret_key")
    @classmethod
    def validate_jwt_secret_outside_development(cls, v: str, info: Any) -> str:
        env = info.data.get("environment", "development")
        if env == "production" and "dev-secret-key" in v.lower():
            raise ValueError("JWT_SECRET_KEY must be set in production! Generate one with: openssl rand -hex 32")
        return v

    @field_validator("dev_auth_enabled")
    @classmethod
    def forbid_dev_auth_in_production(cls, v: bool, info: Any) -> bool:
        env = info.data.get("environment", "development")
        if env == "production" and v:
            raise ValueError("DEV_AUTH_ENABLED must be false in production. It bypasses the sign-in code.")
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
