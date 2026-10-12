"""
Журнал событий аккаунтов: создание и удаление аккаунтов, входы и выходы,
заходы в приложение. Нужен для статистики (новые пользователи, активность,
удержание, длительность заходов) и чтобы замечать подозрительное (перебор
паролей, массовое создание аккаунтов).

Хранение — обычный текст, как и остальные данные:

  Data/logs/events-ГГГГ-ММ.txt   — новый файл каждый месяц

Одна строка — одно событие:

  <время> <событие> ключ=значение ключ="значение с пробелами" …

  2026-10-12T08:50:13+03:00 account.create uid=3fa8… name=user-4821 gid=5e2a91c0 trigger=board_create ip=192.168.1.5 ua="Safari 18 / macOS"

Время — с часовым поясом. Строки только дописываются, каждая — сразу
(файл открывается, строка дописывается, файл закрывается). Значения
очищаются от управляющих символов (перевода строки и т.п.) и обрезаются по
длине — иначе через User-Agent можно было бы дописать в журнал поддельную
строку. Пароли, их хэши, ключ гостя и содержимое cookie сюда не пишутся.
Ошибка записи не мешает запросу пользователя: событие просто теряется.

Список событий и их полей — README.md, раздел «Журнал событий».
"""

import hashlib
import os
import re
import threading
import unicodedata
from datetime import datetime

# Сколько месяцев хранить журнал (более старые файлы удаляются фоновой уборкой)
LOG_KEEP_MONTHS = 12

VALUE_MAX = 200     # максимальная длина значения поля
UA_MAX = 60         # User-Agent, который не удалось разобрать, обрезается до стольких символов

FILE_RE = re.compile(r"^events-(\d{4})-(\d{2})\.txt$")
# значение без кавычек: только «безопасные» символы
PLAIN_RE = re.compile(r"^[^\s\"=\\]+$")


def now_iso() -> str:
    """Текущее время с часовым поясом: 2026-10-12T09:15:02+03:00."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def local_iso(value: str) -> str:
    """Время из users.txt (там оно без пояса, местное) — с часовым поясом."""
    try:
        return datetime.fromisoformat(value).astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return value or ""


def fingerprint(secret: str) -> str:
    """Короткий отпечаток секрета (ключа гостя): по нему можно связать события
    одного гостя, но восстановить сам ключ нельзя."""
    return hashlib.sha256((secret or "").encode("utf-8")).hexdigest()[:8]


def clean(value, limit: int = VALUE_MAX) -> str:
    """Убирает управляющие и невидимые символы, схлопывает пробелы, обрезает."""
    text = unicodedata.normalize("NFC", str(value))
    text = "".join(" " if unicodedata.category(ch).startswith(("C", "Z")) else ch
                   for ch in text)
    return " ".join(text.split())[:limit]


def format_value(value) -> str:
    text = clean(value)
    if text and PLAIN_RE.match(text):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def format_line(event: str, fields: dict, when: str = "") -> str:
    parts = [when or now_iso(), event.ljust(14)]
    for key, value in fields.items():
        if value is None or value == "":
            continue
        parts.append(f"{key}={format_value(value)}")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Сокращённый User-Agent: «Chrome 129 / Windows»
# ---------------------------------------------------------------------------

_BROWSERS = [
    # (название, шаблон версии) — порядок важен: Edge, Opera и Яндекс.Браузер
    # тоже пишут о себе «Chrome», а Chrome — «Safari»
    ("Edge", r"Edg(?:e|A|iOS)?/(\d+)"),
    ("Opera", r"(?:OPR|OPT)/(\d+)"),
    ("Yandex", r"YaBrowser/(\d+)"),
    ("Firefox", r"(?:Firefox|FxiOS)/(\d+)"),
    ("Chrome", r"(?:Chrome|CriOS)/(\d+)"),
    ("Safari", r"Version/(\d+).*Safari/"),
]
_SYSTEMS = [
    ("Android", r"Android"),
    ("iOS", r"iPhone|iPad|iPod"),
    ("Windows", r"Windows"),
    ("macOS", r"Mac OS X|Macintosh"),
    ("Linux", r"Linux|X11"),
]


def short_user_agent(ua: str) -> str:
    ua = ua or ""
    if not ua:
        return ""
    browser = ""
    for name, pattern in _BROWSERS:
        m = re.search(pattern, ua)
        if m:
            browser = f"{name} {m.group(1)}"
            break
    system = next((name for name, pattern in _SYSTEMS if re.search(pattern, ua)), "")
    if browser and system:
        return f"{browser} / {system}"
    # не браузер (бот, curl, скрипт) — первые символы как есть
    return clean(ua, UA_MAX)


def is_bot(ua: str) -> bool:
    """Поисковые роботы и проверялки ссылок — их не считаем гостями."""
    return bool(re.search(r"bot|crawl|spider|slurp|preview|monitor|curl|wget|python-requests",
                          ua or "", re.IGNORECASE))


# ---------------------------------------------------------------------------
# Запись
# ---------------------------------------------------------------------------

class EventLog:
    def __init__(self, data_dir: str):
        self.logs_dir = os.path.join(data_dir, "logs")
        self._lock = threading.Lock()

    def file_for(self, when: datetime) -> str:
        return os.path.join(self.logs_dir, f"events-{when:%Y-%m}.txt")

    def write(self, event: str, **fields) -> None:
        """Дописывает событие в журнал текущего месяца. Никогда не бросает
        исключений — журнал не должен ломать запрос пользователя."""
        try:
            now = datetime.now().astimezone()
            line = format_line(event, fields, now.isoformat(timespec="seconds"))
            with self._lock:
                os.makedirs(self.logs_dir, exist_ok=True)
                with open(self.file_for(now), "a", encoding="utf-8") as f:
                    f.write(line + "\n")
        except Exception as err:  # noqa: BLE001 — любая ошибка записи не важнее запроса
            print("[events] не удалось записать событие:", event, err)

    def prune(self, keep_months: int = LOG_KEEP_MONTHS) -> int:
        """Удаляет файлы журнала старше keep_months месяцев (текущий месяц —
        первый из них). Возвращает число удалённых файлов."""
        now = datetime.now()
        current = now.year * 12 + now.month - 1
        removed = 0
        try:
            names = os.listdir(self.logs_dir)
        except OSError:
            return 0
        for name in names:
            m = FILE_RE.match(name)
            if not m:
                continue
            month = int(m.group(1)) * 12 + int(m.group(2)) - 1
            if current - month >= keep_months:
                try:
                    os.remove(os.path.join(self.logs_dir, name))
                    removed += 1
                except OSError:
                    pass
        return removed


# ---------------------------------------------------------------------------
# Чтение (для скриптов статистики)
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')
_LINE_RE = re.compile(r"^(\S+)\s+([a-z]+\.[a-z]+)\s*(.*)$")


def parse_line(line: str):
    """Строка журнала -> {"time", "event", поля…} или None, если строка
    испорчена (например, недописана при внезапном отключении)."""
    m = _LINE_RE.match(line.strip())
    if not m:
        return None
    try:
        datetime.fromisoformat(m.group(1))
    except ValueError:
        return None
    record = {"time": m.group(1), "event": m.group(2)}
    for key, raw in _TOKEN_RE.findall(m.group(3)):
        if raw.startswith('"'):
            if len(raw) < 2 or not raw.endswith('"'):
                return None
            raw = re.sub(r"\\(.)", r"\1", raw[1:-1])
        record[key] = raw
    return record


def read_events(logs_dir: str):
    """Все события из всех файлов журнала по порядку (испорченные строки пропускаются)."""
    try:
        names = sorted(n for n in os.listdir(logs_dir) if FILE_RE.match(n))
    except OSError:
        return
    for name in names:
        with open(os.path.join(logs_dir, name), "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                record = parse_line(line)
                if record:
                    yield record
