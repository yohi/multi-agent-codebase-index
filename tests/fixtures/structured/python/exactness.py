from package import one as alias
from .relative import local
from package import *
import module as module_alias

# unrelated
class Service:
    @cache
    async def fetch(self, key: str) -> str:
        """Return one cached value."""
        return key


def outer():
    def inner():
        return "nested"

    return inner()


left, right = (1, 2)


def generic[T](value: T) -> T:
    return value


def 日本語() -> str:
    return "狐"


async def top_level_async() -> None:
    return None


alias = "shadowed"


class Duplicate:
    def first(self):
        return 1


class Duplicate:
    def second(self):
        return 2


class Broken:
    def broken(
