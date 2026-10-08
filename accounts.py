"""
Аккаунты пользователей канбан-доски.

Каждый пользователь — своё пространство досок. Аккаунт создаётся не при заходе,
а при первом изменении (см. app.py, «гость»). Логин генерируется автоматически
(вида user-4821); пользователь может один раз поменять его на свой, после этого
логин больше не меняется. Пароля сначала
нет — пользователь задаёт его сам, и только после этого может войти в своё
пространство с другого устройства.

Хранение (человекочитаемый текст, как и доски):

  Data/users.txt               — все аккаунты (формат ниже)
  Data/users/<id>/<guid>.txt   — доски пользователя
  Data/users/<id>/boards-order.txt — порядок досок пользователя

Формат Data/users.txt:

  USER id=3fa85f64-5717-4562-b3fc-2c963f66afa6
  NAME: alexey
  RENAMED: 1                      (логин уже меняли — больше менять нельзя;
                                   строки нет, пока логин автоматический)
  PASSWORD: pbkdf2:sha256:...     (строки нет, пока пароль не задан)
  VER: 1                          (версия сессий: +1 при смене пароля —
                                   все остальные устройства выходят из аккаунта)
  CREATED: 2026-10-05T08:20:00
  SEEN: 2026-10-05T08:20:00       (последний заход, обновляется раз в сутки)
  VISITS: 3                       (сколько раз заходили в аккаунт: заход —
                                   открытие приложения после перерыва
                                   VISIT_GAP_MINUTES; первый — создание)
  VISITAT: 2026-10-05T08:20:00    (когда последний раз открывали страницу)
  ENDUSER
"""

import os
import re
import secrets
import shutil
import threading
import unicodedata
import uuid
from datetime import datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Логин (он же имя пространства): латинские буквы, цифры, «-» и «_», от 3 до 30
# символов. Уникален без учёта регистра. Сначала автоматический (user-4821),
# пользователь может один раз поменять его на свой.
# Буквы — латинские или русские, но не вперемешку в одном логине (иначе можно
# завести логин-двойник: русская «а» и латинская «a» выглядят одинаково).
# Сравнение логинов — без учёта регистра и с «ё» = «е» (см. name_key).
NAME_RE = re.compile(r"^[A-Za-zА-Яа-яЁё0-9_-]{3,30}$")
LATIN_RE = re.compile(r"[A-Za-z]")
CYRILLIC_RE = re.compile(r"[А-Яа-яЁё]")
# максимум 30 символов не упоминаем — длиннее поле ввода и так не даст набрать
NAME_RULES_TEXT = "От 3 символов, русские или латинские буквы, цифры, «-» и «_»."
NAME_MIXED_TEXT = "В логине должны быть либо только русские, либо только латинские буквы."


def normalize_name(name: str) -> str:
    """Единая форма записи: «й»/«ё», набранные двумя символами (буква + значок),
    становятся одним символом; пробелы по краям убираются."""
    return unicodedata.normalize("NFC", name or "").strip()


def name_key(name: str) -> str:
    """Ключ для сравнения логинов: без учёта регистра, «ё» = «е»."""
    return normalize_name(name).lower().replace("ё", "е")


# Латинские буквы, которые выглядят как русские (в любом регистре)
_LOOKALIKES = str.maketrans("aeopcxykmthb", "аеорсхукмтнв")


def name_skeleton(name: str) -> str:
    """«Силуэт» логина: похожие латинские и русские буквы считаются одной.
    Логин занят, если у другого аккаунта такой же силуэт — так нельзя завести
    русский «ахеу», если есть латинский «axey» (на вид они одинаковые)."""
    return name_key(name).translate(_LOOKALIKES)

PASSWORD_MIN = 6
PASSWORD_MAX = 128

# Пустые аккаунты без пароля, в которые не заходили столько дней, удаляются
CLEANUP_AFTER_DAYS = 30

# Заход в аккаунт — открытие приложения после перерыва не меньше стольких минут
# (перезагрузки и переходы между досками подряд — тот же заход)
VISIT_GAP_MINUTES = 30
# У аккаунтов, созданных до подсчёта заходов, считаем заходов «много»
VISITS_UNKNOWN = 99


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

    def __init__(self, data_dir: str, is_untouched_board=None):
        """is_untouched_board(path, board_id) -> bool: доска — нетронутая копия
        шаблонной (такие доски при чистке не считаются, как будто их нет)."""
        self.data_dir = data_dir
        self.is_untouched_board = is_untouched_board
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
                               "renamed": False, "ver": 1, "created": "", "seen": "",
                               "visits": VISITS_UNKNOWN, "visit_at": ""}
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
                elif key == "RENAMED":
                    current["renamed"] = value not in ("", "0")
                elif key == "VER":
                    try:
                        current["ver"] = max(1, int(value))
                    except ValueError:
                        current["ver"] = 1
                elif key == "CREATED":
                    current["created"] = value
                elif key == "SEEN":
                    current["seen"] = value
                elif key == "VISITS":
                    try:
                        current["visits"] = max(1, int(value))
                    except ValueError:
                        pass
                elif key == "VISITAT":
                    current["visit_at"] = value
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
            if u.get("renamed"):
                lines.append("RENAMED: 1")
            if u.get("password"):
                lines.append(f"PASSWORD: {u['password']}")
            lines.append(f"VER: {u.get('ver', 1)}")
            lines.append(f"CREATED: {u.get('created', '')}")
            lines.append(f"SEEN: {u.get('seen', '')}")
            lines.append(f"VISITS: {u.get('visits', VISITS_UNKNOWN)}")
            if u.get("visit_at"):
                lines.append(f"VISITAT: {u['visit_at']}")
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
        key = name_key(name)
        with self._lock:
            for u in self._load():
                if name_key(u["name"]) == key:
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

    def validate_name(self, name: str, user_id: str = ""):
        """Возвращает текст ошибки или None, если логин подходит и свободен
        (свой собственный логин — например, со сменой регистра — не считается занятым)."""
        name = normalize_name(name)
        if not NAME_RE.match(name):
            return NAME_RULES_TEXT
        if LATIN_RE.search(name) and CYRILLIC_RE.search(name):
            return NAME_MIXED_TEXT
        skeleton = name_skeleton(name)
        with self._lock:
            for u in self._load():
                if u["id"] != user_id and name_skeleton(u["name"]) == skeleton:
                    return "Этот логин уже занят."
        return None

    def create(self, name: str = ""):
        """Создаёт аккаунт без пароля. Без name — с автоматическим логином вида
        user-4821; с name — сразу с этим логином (это и есть единственная смена
        логина). Возвращает (аккаунт, None) или (None, текст ошибки)."""
        name = normalize_name(name)
        with self._lock:
            if name:
                error = self.validate_name(name)
                if error:
                    return None, error
            users = self._load()
            taken = {name_key(u["name"]) for u in users}
            renamed = bool(name)
            for attempt in range(0 if name else 200):
                digits = 4 if attempt < 100 else 6
                candidate = "user-" + "".join(secrets.choice("0123456789") for _ in range(digits))
                if candidate not in taken:
                    name = candidate
                    break
            if not name:
                name = "user-" + secrets.token_hex(4)
            now = _now()
            user = {"id": str(uuid.uuid4()), "name": name, "password": "",
                    "renamed": renamed, "ver": 1, "created": now, "seen": now,
                    "visits": 1, "visit_at": now}
            users.append(user)
            self._save(users)
            os.makedirs(self.user_dir(user["id"]), exist_ok=True)
            return dict(user), None

    def rename(self, user_id: str, name: str):
        """Меняет логин — только один раз. Возвращает текст ошибки или None."""
        name = normalize_name(name)
        with self._lock:
            users = self._load()
            user = next((u for u in users if u["id"] == user_id), None)
            if not user:
                return "Аккаунт не найден."
            if user.get("renamed"):
                return "Логин уже меняли — второй раз изменить его нельзя."
            error = self.validate_name(name, user_id)
            if error:
                return error
            user["name"] = name
            user["renamed"] = True
            self._save(users)
            return None

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

    def register_visit(self, user_id: str) -> int:
        """Отмечает открытие страницы. Если с прошлого открытия прошло не меньше
        VISIT_GAP_MINUTES — это новый заход (счётчик +1). Возвращает число заходов."""
        with self._lock:
            users = self._load()
            user = next((u for u in users if u["id"] == user_id), None)
            if not user:
                return 0
            now = datetime.now()
            last = _parse_time(user.get("visit_at", ""))
            changed = False
            if last is None or now - last >= timedelta(minutes=VISIT_GAP_MINUTES):
                if last is not None or user.get("visits") != VISITS_UNKNOWN:
                    user["visits"] = int(user.get("visits", 1)) + 1
                changed = True
            # время последнего открытия — не чаще раза в минуту, чтобы не писать файл зря
            if last is None or now - last >= timedelta(minutes=1):
                user["visit_at"] = _now()
                changed = True
            if changed:
                self._save(users)
            return int(user["visits"])

    # ------------------------------------------------------------------
    # Чистка пустых аккаунтов
    # ------------------------------------------------------------------

    def _has_boards(self, user_id: str) -> bool:
        """Есть ли у пользователя свои доски. Нетронутые копии шаблонных досок
        не считаются: аккаунт только с ними — то же, что пустой."""
        folder = self.user_dir(user_id)
        try:
            names = os.listdir(folder)
        except OSError:
            return False
        for f in names:
            if not (f.endswith(".txt") and UUID_RE.match(f[:-4])):
                continue
            path = os.path.join(folder, f)
            if self.is_untouched_board and self.is_untouched_board(path, f[:-4]):
                continue
            return True
        return False

    def cleanup(self) -> int:
        """Удаляет аккаунты без пароля и без своих досок (нетронутые шаблонные
        доски не в счёт), в которые не заходили
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
