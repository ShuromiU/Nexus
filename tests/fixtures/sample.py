"""Sample Python module for testing."""

import os
from pathlib import Path
from typing import Optional, List
from dataclasses import dataclass
import json as j

MAX_RETRIES = 3

_internal_var = "hidden"


@dataclass
class User:
    """A user in the system."""
    id: str
    name: str
    email: str


class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def find_user(self, user_id: str) -> Optional["User"]:
        """Find a user by ID."""
        return self.db.find(user_id)

    @staticmethod
    def create() -> "UserService":
        """Factory method."""
        return UserService(None)


def greet(name: str) -> str:
    """Greet a person by name."""
    return f"Hello, {name}!"


async def fetch_data(url: str) -> bytes:
    """Fetch data from URL."""
    pass


def _private_helper():
    pass


CONSTANT_VALUE: int = 42


class Status:
    ACTIVE = "active"
    INACTIVE = "inactive"
