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

import atexit
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



# Неважные изменения (время последнего захода, счётчик заходов) записываются
# в файл не сразу, а пачкой — не чаще раза в столько секунд. Важные (новый
# аккаунт, логин, пароль, чистка) — сразу.
SAVE_DELAY_SECONDS = 5


class AccountStore:
    """Хранилище аккаунтов в Data/users.txt.

    Файл читается один раз и держится в памяти (со словарями по id, логину и
    «силуэту» логина), поэтому поиск аккаунта не зависит от их числа. Если
    файл поменяли вручную при работающем сервере — он перечитывается сам
    (сверяем время изменения файла). Все операции — под одной блокировкой,
    файл перезаписывается атомарно (через временный файл).

    Сервер должен работать одним процессом (потоков — сколько угодно):
    у каждого процесса была бы своя копия аккаунтов в памяти."""

    def __init__(self, data_dir: str, is_untouched_board=None):
        """is_untouched_board(path, board_id) -> bool: доска — нетронутая копия
        шаблонной (такие доски при чистке не считаются, как будто их нет)."""
        self.data_dir = data_dir
        self.is_untouched_board = is_untouched_board
        self.users_file = os.path.join(data_dir, "users.txt")
        self.users_dir = os.path.join(data_dir, "users")
        self._lock = threading.RLock()
        self._users = []          # аккаунты в порядке файла
        self._by_id = {}          # id -> аккаунт
        self._by_key = {}         # name_key(логин) -> аккаунт
        self._by_skeleton = {}    # name_skeleton(логин) -> аккаунт
        self._loaded = False
        self._loaded_mtime = None
        self._dirty = False       # в памяти есть изменения, ещё не записанные в файл
        self._flush_timer = None
        atexit.register(self.flush)

    # ------------------------------------------------------------------
    # Чтение / запись файла аккаунтов
    # ------------------------------------------------------------------

    def _file_mtime(self):
        try:
            return os.stat(self.users_file).st_mtime_ns
        except OSError:
            return None

    def _read_file(self) -> list:
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

    def _reindex(self) -> None:
        """Пересобирает словари поиска (при повторах логина побеждает первый
        в файле — как раньше при поиске по порядку)."""
        self._by_id, self._by_key, self._by_skeleton = {}, {}, {}
        for u in self._users:
            self._index(u)

    def _index(self, u: dict) -> None:
        self._by_id.setdefault(u["id"], u)
        self._by_key.setdefault(name_key(u["name"]), u)
        self._by_skeleton.setdefault(name_skeleton(u["name"]), u)

    def _ensure_loaded(self) -> None:
        """Загружает файл при первом обращении и перечитывает, если его
        поменяли снаружи (а у нас нет незаписанных изменений). Под self._lock."""
        mtime = self._file_mtime()
        if self._loaded and (self._dirty or mtime == self._loaded_mtime):
            return
        self._users = self._read_file()
        self._reindex()
        self._loaded = True
        self._loaded_mtime = mtime

    def _serialize(self) -> str:
        lines = [
            "# Аккаунты канбан-доски. Пароли хранятся только в виде хэша.",
            "# Формат: USER id=<id> / NAME: / PASSWORD: (если задан) / VER: / CREATED: / SEEN: / ENDUSER",
            "",
        ]
        for u in self._users:
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
        return "\n".join(lines)

    def _write_now(self) -> None:
        """Записывает аккаунты в файл сейчас же. Под self._lock."""
        os.makedirs(self.data_dir, exist_ok=True)
        tmp = self.users_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(self._serialize())
        os.replace(tmp, self.users_file)
        self._loaded_mtime = self._file_mtime()
        self._dirty = False

    def _changed(self, urgent: bool) -> None:
        """Отмечает изменение: важное записывается сразу, неважное — через
        SAVE_DELAY_SECONDS вместе с остальными. Под self._lock."""
        self._dirty = True
        if urgent:
            self._write_now()
        elif self._flush_timer is None:
            timer = threading.Timer(SAVE_DELAY_SECONDS, self.flush)
            timer.daemon = True
            self._flush_timer = timer
            timer.start()

    def flush(self) -> None:
        """Записывает незаписанные изменения (по таймеру и при остановке сервера)."""
        with self._lock:
            self._flush_timer = None
            if self._dirty:
                try:
                    self._write_now()
                except OSError as err:
                    print("[accounts] не удалось записать users.txt:", err)

    # ------------------------------------------------------------------
    # Поиск
    # ------------------------------------------------------------------

    def get(self, user_id: str):
        with self._lock:
            self._ensure_loaded()
            u = self._by_id.get(user_id)
            return dict(u) if u else None

    def find_by_name(self, name: str):
        with self._lock:
            self._ensure_loaded()
            u = self._by_key.get(name_key(name))
            return dict(u) if u else None

    def count(self) -> int:
        with self._lock:
            self._ensure_loaded()
            return len(self._users)

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
        with self._lock:
            self._ensure_loaded()
            other = self._by_skeleton.get(name_skeleton(name))
            if other and other["id"] != user_id:
                return "Этот логин уже занят."
        return None

    def create(self, name: str = ""):
        """Создаёт аккаунт без пароля. Без name — с автоматическим логином вида
        user-4821; с name — сразу с этим логином (это и есть единственная смена
        логина). Возвращает (аккаунт, None) или (None, текст ошибки)."""
        name = normalize_name(name)
        with self._lock:
            self._ensure_loaded()
            if name:
                error = self.validate_name(name)
                if error:
                    return None, error
            renamed = bool(name)
            for attempt in range(0 if name else 200):
                digits = 4 if attempt < 100 else 6
                candidate = "user-" + "".join(secrets.choice("0123456789") for _ in range(digits))
                if name_key(candidate) not in self._by_key:
                    name = candidate
                    break
            if not name:
                name = "user-" + secrets.token_hex(4)
            now = _now()
            user = {"id": str(uuid.uuid4()), "name": name, "password": "",
                    "renamed": renamed, "ver": 1, "created": now, "seen": now,
                    "visits": 1, "visit_at": now}
            self._users.append(user)
            self._index(user)
            self._changed(urgent=True)
            os.makedirs(self.user_dir(user["id"]), exist_ok=True)
            return dict(user), None

    def rename(self, user_id: str, name: str):
        """Меняет логин — только один раз. Возвращает текст ошибки или None."""
        name = normalize_name(name)
        with self._lock:
            self._ensure_loaded()
            user = self._by_id.get(user_id)
            if not user:
                return "Аккаунт не найден."
            if user.get("renamed"):
                return "Логин уже меняли — второй раз изменить его нельзя."
            error = self.validate_name(name, user_id)
            if error:
                return error
            user["name"] = name
            user["renamed"] = True
            self._reindex()
            self._changed(urgent=True)
            return None

    # ------------------------------------------------------------------
    # Пароль
    # ------------------------------------------------------------------

    def set_password(self, user_id: str, password: str) -> int:
        """Задаёт пароль и увеличивает версию сессий (все остальные устройства
        выходят из аккаунта). Возвращает новую версию."""
        # хэш считается долго (~0,1 с) — вне блокировки, чтобы не задерживать других
        password_hash = generate_password_hash(password)
        with self._lock:
            self._ensure_loaded()
            user = self._by_id.get(user_id)
            if not user:
                return 1
            user["password"] = password_hash
            user["ver"] = int(user.get("ver", 1)) + 1
            self._changed(urgent=True)
            return user["ver"]

    @staticmethod
    def check_password(user: dict, password: str) -> bool:
        return bool(user and user.get("password")) and check_password_hash(user["password"], password or "")

    def touch(self, user_id: str) -> None:
        """Отмечает заход пользователя (обновляется не чаще раза в сутки)."""
        with self._lock:
            self._ensure_loaded()
            u = self._by_id.get(user_id)
            if not u:
                return
            seen = _parse_time(u.get("seen", ""))
            if not seen or datetime.now() - seen > timedelta(days=1):
                u["seen"] = _now()
                self._changed(urgent=False)

    def register_visit(self, user_id: str) -> int:
        """Отмечает открытие страницы. Если с прошлого открытия прошло не меньше
        VISIT_GAP_MINUTES — это новый заход (счётчик +1). Возвращает число заходов."""
        with self._lock:
            self._ensure_loaded()
            user = self._by_id.get(user_id)
            if not user:
                return 0
            now = datetime.now()
            last = _parse_time(user.get("visit_at", ""))
            changed = False
            if last is None or now - last >= timedelta(minutes=VISIT_GAP_MINUTES):
                if last is not None or user.get("visits") != VISITS_UNKNOWN:
                    user["visits"] = int(user.get("visits", 1)) + 1
                changed = True
            # время последнего открытия — не чаще раза в минуту
            if last is None or now - last >= timedelta(minutes=1):
                user["visit_at"] = _now()
                changed = True
            if changed:
                self._changed(urgent=False)
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

    @staticmethod
    def _is_stale(u: dict, limit: datetime) -> bool:
        if u.get("password"):
            return False
        seen = _parse_time(u.get("seen", "")) or _parse_time(u.get("created", ""))
        return seen is not None and seen < limit

    def cleanup(self) -> int:
        """Удаляет аккаунты без пароля и без своих досок (нетронутые шаблонные
        доски не в счёт), в которые не заходили больше CLEANUP_AFTER_DAYS дней.
        Папки досок проверяются без блокировки — остальные запросы в это время
        не ждут. Возвращает число удалённых."""
        limit = datetime.now() - timedelta(days=CLEANUP_AFTER_DAYS)
        with self._lock:
            self._ensure_loaded()
            candidates = [u["id"] for u in self._users if self._is_stale(u, limit)]
        empty = {uid for uid in candidates if not self._has_boards(uid)}
        if not empty:
            return 0
        with self._lock:
            self._ensure_loaded()
            # пока проверяли папки, пользователь мог зайти или задать пароль
            removed = {u["id"] for u in self._users
                       if u["id"] in empty and self._is_stale(u, limit)}
            if not removed:
                return 0
            self._users = [u for u in self._users if u["id"] not in removed]
            self._reindex()
            self._changed(urgent=True)
        for uid in removed:
            shutil.rmtree(self.user_dir(uid), ignore_errors=True)
        print(f"[accounts] удалено пустых аккаунтов без пароля: {len(removed)}")
        return len(removed)
