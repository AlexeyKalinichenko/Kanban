"""
Аккаунты пользователей канбан-доски.

Каждый пользователь — своё пространство досок. Логин пользователь придумывает
сам при создании пространства (на странице входа); после создания логин не
меняется. Пароля сначала нет — пользователь задаёт его сам, и только после
этого может войти в своё пространство с другого устройства.

Хранение (человекочитаемый текст, как и доски):

  Data/users.txt               — все аккаунты (формат ниже)
  Data/users/<id>/<guid>.txt   — доски пользователя
  Data/users/<id>/boards-order.txt — порядок досок пользователя

Формат Data/users.txt:

  USER id=3fa85f64-5717-4562-b3fc-2c963f66afa6
  NAME: alexey
  PASSWORD: pbkdf2:sha256:...     (строки нет, пока пароль не задан)
  VER: 1                          (версия сессий: +1 при смене пароля —
                                   все остальные устройства выходят из аккаунта)
  CREATED: 2026-10-05T08:20:00
  SEEN: 2026-10-05T08:20:00       (последний заход, обновляется раз в сутки)
  ENDUSER
"""

import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Логин (он же имя пространства): латинские буквы, цифры, «-» и «_», от 3 до 30
# символов. Уникален без учёта регистра. Задаётся при создании и больше не меняется.
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,30}$")
NAME_RULES_TEXT = "От 3 до 30 символов: латинские буквы, цифры, «-» и «_»."

PASSWORD_MIN = 6
PASSWORD_MAX = 128

# Пустые аккаунты без пароля, в которые не заходили столько дней, удаляются
CLEANUP_AFTER_DAYS = 30


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_time(value: str):
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


class AccountStore:
    """Хранилище аккаунтов в Data/users.txt. Все операции — под одной блокировкой,
    файл перезаписывается атомарно (через временный файл)."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.users_file = os.path.join(data_dir, "users.txt")
        self.users_dir = os.path.join(data_dir, "users")
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Чтение / запись файла аккаунтов
    # ------------------------------------------------------------------

    def _load(self) -> list:
        try:
            with open(self.users_file, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            return []
        users = []
        current = None
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("USER "):
                m = re.match(r"USER\s+id=(\S+)$", line)
                current = None
                if m and UUID_RE.match(m.group(1)):
                    current = {"id": m.group(1), "name": "", "password": "",
                               "ver": 1, "created": "", "seen": ""}
            elif line == "ENDUSER":
                if current and current["name"]:
                    users.append(current)
                current = None
            elif current is not None:
                key, _, value = line.partition(":")
                value = value.strip()
                key = key.strip().upper()
                if key == "NAME":
                    current["name"] = value
                elif key == "PASSWORD":
                    current["password"] = value
                elif key == "VER":
                    try:
                        current["ver"] = max(1, int(value))
                    except ValueError:
                        current["ver"] = 1
                elif key == "CREATED":
                    current["created"] = value
                elif key == "SEEN":
                    current["seen"] = value
        return users

    def _save(self, users: list) -> None:
        os.makedirs(self.data_dir, exist_ok=True)
        lines = [
            "# Аккаунты канбан-доски. Пароли хранятся только в виде хэша.",
            "# Формат: USER id=<id> / NAME: / PASSWORD: (если задан) / VER: / CREATED: / SEEN: / ENDUSER",
            "",
        ]
        for u in users:
            lines.append(f"USER id={u['id']}")
            lines.append(f"NAME: {u['name']}")
            if u.get("password"):
                lines.append(f"PASSWORD: {u['password']}")
            lines.append(f"VER: {u.get('ver', 1)}")
            lines.append(f"CREATED: {u.get('created', '')}")
            lines.append(f"SEEN: {u.get('seen', '')}")
            lines.append("ENDUSER")
            lines.append("")
        tmp = self.users_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        os.replace(tmp, self.users_file)

    # ------------------------------------------------------------------
    # Поиск
    # ------------------------------------------------------------------

    def get(self, user_id: str):
        with self._lock:
            for u in self._load():
                if u["id"] == user_id:
                    return dict(u)
        return None

    def find_by_name(self, name: str):
        key = (name or "").strip().lower()
        with self._lock:
            for u in self._load():
                if u["name"].lower() == key:
                    return dict(u)
        return None

    def count(self) -> int:
        with self._lock:
            return len(self._load())

    def user_dir(self, user_id: str) -> str:
        return os.path.join(self.users_dir, user_id)

    # ------------------------------------------------------------------
    # Создание аккаунта
    # ------------------------------------------------------------------

    def validate_name(self, name: str):
        """Возвращает текст ошибки или None, если логин подходит и свободен."""
        name = (name or "").strip()
        if not NAME_RE.match(name):
            return NAME_RULES_TEXT
        if self.find_by_name(name):
            return "Этот логин уже занят."
        return None

    def create(self, name: str):
        """Создаёт аккаунт с выбранным логином, без пароля.
        Возвращает (аккаунт, None) или (None, текст ошибки)."""
        name = (name or "").strip()
        with self._lock:
            error = self.validate_name(name)
            if error:
                return None, error
            users = self._load()
            now = _now()
            user = {"id": str(uuid.uuid4()), "name": name, "password": "",
                    "ver": 1, "created": now, "seen": now}
            users.append(user)
            self._save(users)
            os.makedirs(self.user_dir(user["id"]), exist_ok=True)
            return dict(user), None

    # ------------------------------------------------------------------
    # Пароль
    # ------------------------------------------------------------------

    def set_password(self, user_id: str, password: str) -> int:
        """Задаёт пароль и увеличивает версию сессий (все остальные устройства
        выходят из аккаунта). Возвращает новую версию."""
        with self._lock:
            users = self._load()
            new_ver = 1
            for u in users:
                if u["id"] == user_id:
                    u["password"] = generate_password_hash(password)
                    u["ver"] = int(u.get("ver", 1)) + 1
                    new_ver = u["ver"]
            self._save(users)
            return new_ver

    @staticmethod
    def check_password(user: dict, password: str) -> bool:
        return bool(user and user.get("password")) and check_password_hash(user["password"], password or "")

    def touch(self, user_id: str) -> None:
        """Отмечает заход пользователя (пишет в файл не чаще раза в сутки)."""
        with self._lock:
            users = self._load()
            changed = False
            for u in users:
                if u["id"] == user_id:
                    seen = _parse_time(u.get("seen", ""))
                    if not seen or datetime.now() - seen > timedelta(days=1):
                        u["seen"] = _now()
                        changed = True
            if changed:
                self._save(users)

    # ------------------------------------------------------------------
    # Чистка пустых аккаунтов
    # ------------------------------------------------------------------

    def _has_boards(self, user_id: str) -> bool:
        folder = self.user_dir(user_id)
        try:
            return any(f.endswith(".txt") and UUID_RE.match(f[:-4]) for f in os.listdir(folder))
        except OSError:
            return False

    def cleanup(self) -> int:
        """Удаляет аккаунты без пароля и без досок, в которые не заходили
        больше CLEANUP_AFTER_DAYS дней. Возвращает число удалённых."""
        with self._lock:
            users = self._load()
            limit = datetime.now() - timedelta(days=CLEANUP_AFTER_DAYS)
            keep, removed = [], []
            for u in users:
                seen = _parse_time(u.get("seen", "")) or _parse_time(u.get("created", ""))
                stale = seen is not None and seen < limit
                if not u.get("password") and stale and not self._has_boards(u["id"]):
                    removed.append(u)
                else:
                    keep.append(u)
            if removed:
                self._save(keep)
                for u in removed:
                    shutil.rmtree(self.user_dir(u["id"]), ignore_errors=True)
                print(f"[accounts] удалено пустых аккаунтов без пароля: {len(removed)}")
            return len(removed)
