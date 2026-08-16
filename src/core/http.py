"""Global exception handling — routes raise, handlers translate.

AuthenticationError subclasses ValueError so Starlette's MRO matching sends
it to the 401 handler while every other ValueError stays a 400.
"""

from typing import TypeVar

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

T = TypeVar("T")

CONSTRAINT_VIOLATION_DETAIL = "That change conflicts with something that already exists."


class AuthenticationError(ValueError):
    """A sign-in attempt that did not establish who the caller is."""


def get_or_404(entity: T | None, detail: str) -> T:
    if entity is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return entity


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AuthenticationError)
    async def _authentication_error(_request: Request, exc: AuthenticationError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": str(exc)})

    @app.exception_handler(ValueError)
    async def _value_error(_request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"detail": str(exc)})

    @app.exception_handler(LookupError)
    async def _lookup_error(_request: Request, exc: LookupError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": str(exc)})

    @app.exception_handler(IntegrityError)
    async def _integrity_error(_request: Request, _exc: IntegrityError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": CONSTRAINT_VIOLATION_DETAIL})
