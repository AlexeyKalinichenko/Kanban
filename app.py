"""
Простой Flask-сервер для канбан-доски (несколько досок, аккаунты пользователей).

- Отдаёт index.html (стартовая страница со списком досок), board.html
  (страница одной доски) и login.html (вход); CSS и JS — в папке static/.
- У каждого пользователя своё пространство досок (см. accounts.py):
  доски пользователя лежат в Data/users/<id пользователя>/<guid>.txt.
- Вход держится на подписанной cookie «kanban_session» = {uid, ver}:
  подпись — ключом из Data/secret.key, ver — версия сессий пользователя
  (растёт при смене пароля, и все остальные устройства выходят из аккаунта).
- Без входа (новый посетитель, после выхода, устаревшая cookie) браузер —
  «гость»: видит шаблонные доски (папка templates/), но на сервере ничего не создаётся,
  в cookie лежит только одноразовый ключ гостя. Аккаунт (логин вида user-4821,
  без пароля) создаётся при первом изменении: смена логина, пароль, новая
  доска, изменение, удаление или перестановка досок. В новое пространство
  копируются шаблонные доски. Войти в существующее
  пространство — кнопка «Войти» на стартовой странице → /login.
- Журнал событий аккаунтов (создание, входы, выходы, заходы) — events.py,
  файлы Data/logs/events-ГГГГ-ММ.txt; список событий — README.md.

Страницы:
- GET    /                       — стартовая страница пространства
- GET    /board/<id>             — своя доска
- GET    /board/<владелец>/<id>  — чужая доска, к которой открыт доступ (общие доски)
- GET    /login                  — вход по логину и паролю
- GET    /admin                  — статистика (только логинам из KANBAN_ADMINS)

API аккаунта:
- GET    /api/account            — логин, задан ли пароль, можно ли сменить логин
- POST   /api/account/name       — сменить логин (только один раз)
- POST   /api/account/name-prompt — гостю показано окно имени (только журнал)
- POST   /api/account/password   — задать / сменить пароль
- POST   /api/login              — войти по логину и паролю
- POST   /api/logout             — выйти
- GET    /api/admin/stats?days=  — цифры для /admin (7, 30 или 90 дней)

API досок (свои доски и чужие, к которым открыт доступ):
- GET    /api/boards            — список всех досок (id + название)
- POST   /api/boards             — создать новую доску, возвращает её id
- DELETE /api/boards/<id>        — удалить доску (удаляет файл)
- POST   /api/boards/order       — сохранить порядок досок на стартовой странице
- GET    /api/board/<id>         — прочитать содержимое доски
- POST   /api/board/<id>         — сохранить (перезаписать) содержимое доски
  (чужая общая доска — те же адреса с ?owner=<id владельца>)

Ссылка-приглашение (общие доски):
- GET    /invite/<секрет>         — открыть доступ по ссылке (гостю — страница
                                   приглашения: сначала имя, затем доска)
- GET    /api/invite/<секрет>     — владелец и название доски (для страницы приглашения)
- POST   /api/invite/<секрет>     — принять приглашение
- POST   /api/board/<id>/link     — включить ссылку ({"reset": true} — новая вместо старой)
- DELETE /api/board/<id>/link     — выключить ссылку

API доступа к доске (общие доски, см. shares.py):
- GET    /api/board/<id>/access               — владелец и те, кому открыт доступ
- POST   /api/board/<id>/access               — открыть доступ по логину (только владелец)
- DELETE /api/board/<id>/access/<uid | me>    — закрыть доступ (владелец — любому,
                                                получатель — только себе)

Данные хранятся в человекочитаемом текстовом файле (см. формат ниже),
а не в базе данных — по условию задачи.
"""

import os
import re
import secrets
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta
from flask import Flask, Response, abort, g, jsonify, redirect, request, session

from accounts import AccountStore, NAME_RULES_TEXT, PASSWORD_MAX, PASSWORD_MIN, VISITS_UNKNOWN, name_key
from events import EventLog, fingerprint, is_bot, local_iso, short_user_agent
import stats
from merge import merge_boards
from shares import ShareStore

# Напоминание «Задайте пароль, чтобы не потерять доступ» показывается
# начиная с этого захода в аккаунт (заход — см. accounts.VISIT_GAP_MINUTES)
PASSWORD_BANNER_FROM_VISIT = 3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Папка с данными всегда лежит рядом с app.py. Доски пользователя — в
# Data/users/<id пользователя>/, имя файла доски — GUID.
DATA_DIR = os.path.join(BASE_DIR, "Data")
os.makedirs(DATA_DIR, exist_ok=True)


def write_text_atomic(path: str, text: str) -> None:
    """Записывает файл целиком через временный файл и подмену: тот, кто
    читает файл в этот момент, видит либо старую, либо новую версию, но не
    половину. Имя временного файла не кончается на .txt — в список досок
    он не попадает."""
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def is_untouched_template_board(path: str, board_id: str) -> bool:
    """Доска пользователя — нетронутая копия шаблонной с тем же id
    (сравниваем содержимое, кроме даты создания)."""
    template = os.path.join(TEMPLATES_DIR, f"{board_id}.txt")
    try:
        with open(template, "r", encoding="utf-8") as f:
            original = parse_board(f.read())
        with open(path, "r", encoding="utf-8") as f:
            current = parse_board(f.read())
    except OSError:
        return False
    for key in ("created", "revision", "missingIds"):
        original[key] = current[key] = ""
    return original == current


# Общие доски (кому владелец открыл доступ) — Data/shares.txt, см. shares.py
shares = ShareStore(DATA_DIR)

# функции разбора досок определены ниже — передаём обёртку; аккаунт с общими
# досками при чистке пустым не считается
accounts = AccountStore(DATA_DIR, lambda path, board_id: is_untouched_template_board(path, board_id),
                        has_shared_boards=shares.involves)
events = EventLog(DATA_DIR)

app = Flask(__name__, static_folder="static", static_url_path="/static")

# За обратным прокси (nginx, Caddy, Cloudflare Tunnel…) настоящий адрес
# посетителя приходит в заголовке X-Forwarded-For — без этого все запросы
# выглядят как пришедшие с адреса прокси, и ограничения «попыток с одного
# адреса» срабатывали бы сразу на всех. Включайте KANBAN_PROXY=1 только когда
# сервер действительно стоит за прокси: иначе заголовок может подделать кто угодно.
if os.environ.get("KANBAN_PROXY") == "1":
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Браузер не должен держать CSS/JS в кэше без проверки: в старых версиях Flask
# по умолчанию разрешено кэшировать статику на 12 часов, и после правок
# в браузере оставалось старое поведение.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


def load_secret_key() -> str:
    """Ключ подписи cookie. Создаётся сам при первом запуске и хранится в
    Data/secret.key. Если ключ потерять или заменить, все пользователи один раз
    окажутся на странице входа (данные при этом не теряются)."""
    path = os.path.join(DATA_DIR, "secret.key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(key + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


app.secret_key = load_secret_key()
app.config.update(
    SESSION_COOKIE_NAME="kanban_session",
    SESSION_COOKIE_HTTPONLY=True,          # скрипты на странице не видят cookie
    SESSION_COOKIE_SAMESITE="Lax",         # чужие сайты не шлют запросы от имени пользователя
    # Только по HTTPS — включается переменной окружения на сервере с HTTPS
    # (пока сервер работает по HTTP на Mac, флаг выключен)
    SESSION_COOKIE_SECURE=os.environ.get("KANBAN_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=365),  # продлевается при каждом заходе
)

STATIC_DIR = os.path.join(BASE_DIR, "static")
STATIC_LINK_RE = re.compile(r'((?:src|href)="/static/)([^"?#]+)"')


def render_page(filename: str) -> Response:
    """Отдаёт HTML-страницу, дописывая к ссылкам на /static/... метку версии
    (?v=<время изменения файла>). После любой правки CSS/JS ссылка меняется,
    и браузер сразу загружает новую версию, а не берёт старую из кэша."""
    with open(os.path.join(BASE_DIR, filename), "r", encoding="utf-8") as f:
        html = f.read()

    def add_version(match):
        path = os.path.join(STATIC_DIR, match.group(2))
        try:
            version = int(os.path.getmtime(path))
        except OSError:
            return match.group(0)
        return f'{match.group(1)}{match.group(2)}?v={version}"'

    html = STATIC_LINK_RE.sub(add_version, html)
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-cache"
    return response

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def is_valid_board_id(board_id: str) -> bool:
    return bool(UUID_RE.match(board_id or ""))


# Шаблонные доски: их видит гость (только чтение), а при создании аккаунта они
# копируются в новое пространство (с теми же id — id доски уникален только
# внутри пространства, поэтому ссылка на открытую доску продолжает работать).
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")


def user_boards_dir() -> str:
    """Папка досок текущего пользователя (Data/users/<id>/); у гостя — папка
    шаблонных досок (её только читают: любое изменение сначала создаёт аккаунт)."""
    if not current_user():
        return TEMPLATES_DIR
    folder = accounts.user_dir(g.user["id"])
    os.makedirs(folder, exist_ok=True)
    return folder


def copy_template_boards(user_id: str) -> None:
    """Копирует шаблонные доски и их порядок в пространство нового аккаунта.
    Дата создания — момент копирования (чтобы новые доски шли после них)."""
    target = accounts.user_dir(user_id)
    os.makedirs(target, exist_ok=True)
    try:
        names = os.listdir(TEMPLATES_DIR)
    except OSError:
        return
    now = datetime.now().isoformat(timespec="seconds")
    for name in names:
        src = os.path.join(TEMPLATES_DIR, name)
        if name == "boards-order.txt":
            shutil.copyfile(src, os.path.join(target, name))
        elif name.endswith(".txt") and is_valid_board_id(name[:-4]):
            with open(src, "r", encoding="utf-8") as f:
                data = parse_board(f.read())
            data["created"] = now
            write_text_atomic(os.path.join(target, name), serialize_board(data))


def board_file_path(board_id: str) -> str:
    return os.path.join(user_boards_dir(), f"{board_id}.txt")


def resolve_board(board_id: str, owner_id: str = ""):
    """Файл доски, которую текущий пользователь может открыть и править:
    свою (owner_id пустой или свой) или чужую, к которой ему открыт доступ.
    Возвращает (путь к файлу, id владельца или "" для своей доски) или
    (None, None), если такой доски нет или доступа к ней нет."""
    if not is_valid_board_id(board_id):
        return None, None
    user = current_user()
    if not owner_id or (user and owner_id == user["id"]):
        path = board_file_path(board_id)
        return (path, "") if os.path.exists(path) else (None, None)
    if not user or not is_valid_board_id(owner_id):
        return None, None
    if not shares.has(owner_id, board_id, user["id"]):
        return None, None
    path = os.path.join(accounts.user_dir(owner_id), f"{board_id}.txt")
    return (path, owner_id) if os.path.exists(path) else (None, None)


def request_owner() -> str:
    """Владелец доски из запроса (?owner=<id>) — для чужих общих досок."""
    return str(request.args.get("owner") or "").strip()


# Порядок досок на стартовой странице (меняется перетаскиванием плиток).
# Хранится отдельным файлом в папке пользователя: по одному id доски на строку,
# сверху вниз = слева направо. Имя файла — не GUID, в список досок он не попадает.
def order_file_path() -> str:
    return os.path.join(user_boards_dir(), "boards-order.txt")


def read_board_order() -> list:
    try:
        with open(order_file_path(), "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    return [l.strip() for l in lines if is_valid_board_id(l.strip())]


def write_board_order(ids: list) -> None:
    seen = set()
    clean = []
    for board_id in ids:
        board_id = str(board_id or "").strip()
        if is_valid_board_id(board_id) and board_id not in seen:
            seen.add(board_id)
            clean.append(board_id)
    text = "# Порядок досок на стартовой странице: по одному id доски на строку\n"
    text += "".join(board_id + "\n" for board_id in clean)
    write_text_atomic(order_file_path(), text)


# ---------------------------------------------------------------------------
# Формат текстового файла одной доски (человекочитаемый, с явными границами блоков):
#
#   # Kanban board data file
#   TITLE: Название доски
#   CREATED: 2026-09-28T08:20:00
#   REVISION: 12
#   BACKGROUND: blue
#
#   TAGDEFS
#   TAGDEF key=yellow color=yellow label=желтый
#   TAGDEF key=tag-1a2b3c color=purple label=Моя метка
#   ENDTAGDEFS
#
#   COLUMN id=k3f9a01c2: Название столбца
#   CARD id=c7d2e4b10 priority=medium tags=yellow,tag-1a2b3c
#   Текст карточки.
#   Может быть
#   многострочным.
#   ENDCARD
#   CARD id=c0a1b2c3d priority=critical
#   Другая карточка
#   ENDCARD
#   ENDCOLUMN
#
#   COLUMN id=k5e6f7a8b: Следующий столбец
#   ENDCOLUMN
#
# Строка BACKGROUND необязательна: если её нет — у доски обычный фон.
# REVISION — номер версии доски: растёт при каждом сохранении; по нему
# открытая доска узнаёт, что её изменил кто-то другой (общие доски).
# id у столбцов и карточек — постоянные (не меняются при переносе и правке):
# по ним сливаются одновременные изменения (merge.py). В старых файлах id нет —
# они добавляются при первом открытии доски.
# Строка CREATED — дата создания доски; по ней доски упорядочены на стартовой
# странице (новые — в конце). У досок, созданных до её появления, строки нет.
# Пустые строки и строки, начинающиеся с "#", вне блока CARD игнорируются.
# ---------------------------------------------------------------------------

PRIORITY_VALUES = {"critical", "medium", "minor"}
DEFAULT_PRIORITY = "medium"
DEFAULT_BOARD_TITLE = "Доска"

# Палитра из 10 возможных цветов тегов (совпадает со списком на фронтенде).
PALETTE_KEYS = {
    "red", "green", "yellow", "blue", "gray",
    "brown", "purple", "cyan", "pink", "lime",
}
DEFAULT_PALETTE_KEY = "gray"

# Максимальная длина названия тега (символов) — как в поле ввода на фронтенде.
# Действует для новых и изменённых названий; теги, которые уже сохранены
# с более длинным названием (до введения лимита), не обрезаются.
TAG_LABEL_MAX = 15

# Цвета фона доски (совпадают со списком в static/board-bg.js).
# Пустая строка — обычный фон (по умолчанию).
BACKGROUND_KEYS = {"blue", "green", "purple", "red", "yellow"}


def normalize_created(value) -> str:
    """Дата создания доски в формате ISO (2026-09-28T08:20:00) или пустая строка."""
    value = str(value or "").strip()
    try:
        return datetime.fromisoformat(value).isoformat(timespec="seconds")
    except ValueError:
        return ""


def normalize_background(value) -> str:
    value = str(value or "").strip().lower()
    return value if value in BACKGROUND_KEYS else ""

# Теги, с которыми стартует новая доска (если явного блока TAGDEFS в файле
# ещё нет, для обратной совместимости используется этот же список).
DEFAULT_TAG_DEFS = [
    {"key": "yellow", "label": "желтый", "color": "yellow"},
    {"key": "blue", "label": "синий", "color": "blue"},
    {"key": "green", "label": "зеленый", "color": "green"},
    {"key": "red", "label": "красный", "color": "red"},
]

# Ключ тега (как встроенного, так и пользовательского) — безопасный токен
# без пробелов: буквы/цифры/подчёркивание/дефис.
KEY_TOKEN_RE = re.compile(r"^[\w-]+$")

# Постоянный id столбца или карточки (буквы, цифры, «-», «_»)
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def new_item_id(prefix: str) -> str:
    """Новый id: k… — столбец, c… — карточка (как в static/board.js)."""
    return prefix + secrets.token_hex(4)


def parse_board(text: str) -> dict:
    """Разбирает содержимое файла доски в структуру
    {"title": ..., "background": ..., "columns": [...], "tagDefs": [...]}."""
    board_title = DEFAULT_BOARD_TITLE
    background = ""
    created = ""
    revision = 0
    columns = []
    current_column = None
    card_lines = None
    card_priority = DEFAULT_PRIORITY
    card_tags = []
    card_id = ""
    # id столбцов и карточек: у кого id нет (старый файл) или он повторяется,
    # получает новый; missing_ids — в файл стоит дописать id
    seen_ids = set()
    missing_ids = False

    def take_id(raw_id: str, prefix: str) -> str:
        nonlocal missing_ids
        if not raw_id or not ITEM_ID_RE.match(raw_id) or raw_id in seen_ids:
            missing_ids = True
            raw_id = new_item_id(prefix)
            while raw_id in seen_ids:
                raw_id = new_item_id(prefix)
        seen_ids.add(raw_id)
        return raw_id

    # None означает "в файле нет явного блока TAGDEFS" — тогда в конце
    # подставляются DEFAULT_TAG_DEFS (совместимость со старыми файлами).
    tag_defs = None
    in_tagdefs = False

    for raw_line in text.splitlines():
        stripped = raw_line.strip()

        # Внутри карточки собираем текст построчно (сохраняем исходные строки,
        # чтобы не терять многострочное форматирование).
        if card_lines is not None:
            if stripped == "ENDCARD":
                card_text = "\n".join(card_lines).strip("\n")
                if current_column is not None:
                    current_column["cards"].append(
                        {"id": card_id, "text": card_text, "priority": card_priority, "tags": card_tags}
                    )
                card_lines = None
                card_priority = DEFAULT_PRIORITY
                card_tags = []
            else:
                card_lines.append(raw_line)
            continue

        if not stripped or stripped.startswith("#"):
            continue

        if in_tagdefs:
            if stripped == "ENDTAGDEFS":
                in_tagdefs = False
            elif stripped.startswith("TAGDEF"):
                match = re.match(r"TAGDEF\s+key=(\S+)\s+color=(\S+)\s+label=(.*)$", stripped)
                if match:
                    key, color, label = match.group(1), match.group(2), match.group(3).strip()
                    if KEY_TOKEN_RE.match(key):
                        if color not in PALETTE_KEYS:
                            color = DEFAULT_PALETTE_KEY
                        tag_defs.append({"key": key, "label": label, "color": color})
            continue

        if stripped == "TAGDEFS":
            tag_defs = []
            in_tagdefs = True
        elif stripped.startswith("TITLE:"):
            board_title = stripped[len("TITLE:"):].strip() or DEFAULT_BOARD_TITLE
        elif stripped.startswith("CREATED:"):
            created = normalize_created(stripped[len("CREATED:"):])
        elif stripped.startswith("REVISION:"):
            try:
                revision = max(0, int(stripped[len("REVISION:"):].strip()))
            except ValueError:
                revision = 0
        elif stripped.startswith("BACKGROUND:"):
            background = normalize_background(stripped[len("BACKGROUND:"):])
        elif stripped.startswith("COLUMN"):
            # COLUMN id=<id>: Название   (в старых файлах — COLUMN: Название)
            match = re.match(r"COLUMN(?:\s+id=(\S*?))?:(.*)$", stripped)
            if not match:
                continue
            title = match.group(2).strip()
            current_column = {"id": take_id(match.group(1) or "", "k"), "title": title, "cards": []}
            columns.append(current_column)
        elif stripped == "ENDCOLUMN":
            current_column = None
        elif stripped.startswith("CARD"):
            match = re.search(r"priority=(\w+)", stripped)
            priority = match.group(1) if match else DEFAULT_PRIORITY
            if priority not in PRIORITY_VALUES:
                priority = DEFAULT_PRIORITY
            card_priority = priority
            id_match = re.search(r"\bid=(\S+)", stripped)
            card_id = take_id(id_match.group(1) if id_match else "", "c")

            # Новый формат: tags=key1,key2 (несколько тегов через запятую,
            # ключи ссылаются на записи в TAGDEFS). Старый формат (один
            # тег, до появления пользовательских тегов): tag=red.
            tags_match = re.search(r"tags=([\w,-]+)", stripped)
            if tags_match:
                raw_tags = tags_match.group(1).split(",")
            else:
                legacy_match = re.search(r"\btag=([\w-]+)", stripped)
                raw_tags = [legacy_match.group(1)] if legacy_match else []

            seen = set()
            card_tags = []
            for t in raw_tags:
                if t and KEY_TOKEN_RE.match(t) and t not in seen:
                    seen.add(t)
                    card_tags.append(t)

            card_lines = []
        # прочие строки вне блоков игнорируются

    if tag_defs is None:
        tag_defs = [dict(t) for t in DEFAULT_TAG_DEFS]

    return {
        "title": board_title,
        "background": background,
        "created": created,
        "revision": revision,
        "columns": columns,
        "tagDefs": tag_defs,
        "missingIds": missing_ids,
    }


def serialize_board(data: dict) -> str:
    """Собирает структуру {"title": ..., "background": ..., "columns": [...], "tagDefs": [...]}
    обратно в текст файла доски."""
    board_title = str(data.get("title", "") or "").replace("\n", " ").strip() or DEFAULT_BOARD_TITLE
    background = normalize_background(data.get("background"))
    created = normalize_created(data.get("created"))
    try:
        revision = max(0, int(data.get("revision") or 0))
    except (TypeError, ValueError):
        revision = 0

    raw_defs = data.get("tagDefs")
    if raw_defs is None:
        raw_defs = DEFAULT_TAG_DEFS

    tag_defs = []
    seen_keys = set()
    for t in raw_defs:
        key = str((t or {}).get("key", "")).strip()
        label = str((t or {}).get("label", "")).strip()
        color = (t or {}).get("color") or DEFAULT_PALETTE_KEY
        if not key or not KEY_TOKEN_RE.match(key) or key in seen_keys:
            continue
        seen_keys.add(key)
        if color not in PALETTE_KEYS:
            color = DEFAULT_PALETTE_KEY
        tag_defs.append((key, color, label))

    lines = [
        "# Kanban board data file",
        "# Формат: TITLE: <название доски>",
        "#         CREATED: <дата создания> (порядок досок на стартовой странице)",
        "#         REVISION: <номер версии> (растёт при каждом сохранении)",
        "#         BACKGROUND: <blue|green|purple|red|yellow> (необязательно, без строки — обычный фон)",
        "#         TAGDEFS ... TAGDEF key=<ключ> color=<цвет> label=<название> ... ENDTAGDEFS",
        "#         COLUMN id=<id>: <название> ... CARD id=<id> priority=<critical|medium|minor> [tags=<ключ1,ключ2,...>] текст ENDCARD ... ENDCOLUMN",
        "#         Доступные цвета: red, green, yellow, blue, gray, brown, purple, cyan, pink, lime",
        f"TITLE: {board_title}",
    ]
    if created:
        lines.append(f"CREATED: {created}")
    if revision:
        lines.append(f"REVISION: {revision}")
    if background:
        lines.append(f"BACKGROUND: {background}")
    lines += [
        "",
        "TAGDEFS",
    ]
    for key, color, label in tag_defs:
        lines.append(f"TAGDEF key={key} color={color} label={label}")
    lines.append("ENDTAGDEFS")
    lines.append("")

    # id без повторов: неправильный или повторный id — новый
    used_ids = set()

    def clean_id(raw, prefix):
        raw = str(raw or "")
        if not ITEM_ID_RE.match(raw) or raw in used_ids:
            raw = new_item_id(prefix)
        used_ids.add(raw)
        return raw

    for column in data.get("columns", []):
        title = str(column.get("title", "")).replace("\n", " ").strip()
        lines.append(f"COLUMN id={clean_id(column.get('id'), 'k')}: {title}")
        for card in column.get("cards", []):
            priority = card.get("priority", DEFAULT_PRIORITY)
            if priority not in PRIORITY_VALUES:
                priority = DEFAULT_PRIORITY

            raw_tags = card.get("tags")
            if raw_tags is None:
                # обратная совместимость: старый формат с одним тегом
                single = card.get("tag")
                raw_tags = [single] if single else []

            seen = set()
            tags = []
            for t in raw_tags:
                if t and KEY_TOKEN_RE.match(t) and t not in seen:
                    seen.add(t)
                    tags.append(t)

            card_header = f"CARD id={clean_id(card.get('id'), 'c')} priority={priority}"
            if tags:
                card_header += f" tags={','.join(tags)}"
            lines.append(card_header)
            text = str(card.get("text", ""))
            lines.extend(text.split("\n"))
            lines.append("ENDCARD")
        lines.append("ENDCOLUMN")
        lines.append("")

    return "\n".join(lines).rstrip("\n") + "\n"


# ---------------------------------------------------------------------------
# Сессия, текущий пользователь, ограничения частоты запросов
# ---------------------------------------------------------------------------

def current_user():
    """Пользователь по cookie сессии или None. Cookie считается действительной,
    если подпись верна, пользователь существует и версия сессий совпадает."""
    if "user" in g:
        return g.user
    user = None
    uid = session.get("uid")
    if uid:
        candidate = accounts.get(uid)
        if candidate and candidate.get("ver") == session.get("ver"):
            user = candidate
        elif candidate:
            # пароль сменили на другом устройстве — эта cookie больше не действует
            events.write("session.end", uid=uid, name=candidate["name"], sid=session.get("sid"),
                         reason="password_changed", ip=client_ip())
            for key in ("uid", "ver", "sid"):
                session.pop(key, None)
    g.user = user
    if user:
        if not session.get("sid"):
            # cookie выдана до появления журнала — даём ей id устройства
            session["sid"] = new_sid()
        accounts.touch(user["id"])
    return user


def new_sid() -> str:
    """Короткий id cookie входа (браузера/устройства) для журнала событий."""
    return secrets.token_hex(4)


def request_ua() -> str:
    return short_user_agent(request.headers.get("User-Agent", ""))


def start_session(user: dict, reason: str = "", sid: str = "") -> None:
    """Выдаёт браузеру cookie входа. reason — для журнала: create (новый
    аккаунт), login (вход по паролю), password (новая cookie после смены
    пароля); без reason событие не пишется. sid — id устройства (по умолчанию
    новый)."""
    previous = current_user()
    if previous and previous["id"] != user["id"]:
        # вход в другое пространство в этом браузере — прежний вход закончился
        events.write("session.end", uid=previous["id"], name=previous["name"],
                     sid=session.get("sid"), reason="switch", ip=client_ip())
    sid = sid or new_sid()
    session.clear()
    session.permanent = True
    session["uid"] = user["id"]
    session["ver"] = user["ver"]
    session["sid"] = sid
    g.user = user
    if reason:
        events.write("session.start", uid=user["id"], name=user["name"], sid=sid,
                     reason=reason, ip=client_ip(), ua=request_ua())


def guest_token():
    """Ключ гостя (браузер без входа) или None."""
    if current_user():
        return None
    return session.get("guest")


def start_guest() -> None:
    """Браузер без входа становится гостем: в cookie — только одноразовый ключ.
    По одному ключу создаётся не больше одного аккаунта (например, если гость
    сделал первое изменение сразу в двух вкладках)."""
    if not session.get("guest") or session.get("uid"):
        session.clear()
        session.permanent = True
        session["guest"] = secrets.token_urlsafe(16)
        raw_ua = request.headers.get("User-Agent", "")
        if not is_bot(raw_ua):
            events.write("guest.start", gid=fingerprint(session["guest"]),
                         ip=client_ip(), ua=request_ua())


# ключ гостя -> (id созданного по нему аккаунта, когда создан, id устройства). Нужен только
# в первые секунды (две вкладки одновременно), старые записи удаляются раз в час.
_guest_accounts = {}
GUEST_ACCOUNT_TTL = 24 * 60 * 60
_guest_lock = threading.Lock()


def ensure_user(name: str = "", trigger: str = ""):
    """Текущий пользователь; гостю — создаёт аккаунт (с логином name или
    автоматическим). trigger — для журнала: что гость пытался сделать (по
    умолчанию — какой запрос создал аккаунт). Возвращает (пользователь, None)
    или (None, ответ-ошибка)."""
    user = current_user()
    if user:
        return user, None
    token = session.get("guest")
    if not token:
        return None, (jsonify({"error": "auth"}), 401)
    with _guest_lock:
        uid, _, sid = _guest_accounts.get(token) or (None, 0, "")
        existing = accounts.get(uid) if uid else None
        if existing:
            # вторая вкладка того же браузера — та же cookie, события не пишем
            start_session(existing, sid=sid)
            return existing, None
        ip = client_ip()
        if is_limited("create", ip, CREATE_LIMIT, CREATE_WINDOW):
            return None, json_error("С этого адреса создано слишком много пространств. Попробуйте позже.", 429)
        sid = new_sid()
        user, error = accounts.create(name, sid)
        if error:
            return None, json_error(error)
        copy_template_boards(user["id"])
        add_hit("create", ip)
        _guest_accounts[token] = (user["id"], time.time(), sid)
        events.write("account.create", uid=user["id"], name=user["name"], gid=fingerprint(token),
                     trigger=trigger or CREATE_TRIGGERS.get(request.endpoint, request.endpoint),
                     ip=ip, ua=request_ua())
        start_session(user, "create", sid)
        # создание аккаунта — его первый заход
        events.write("visit.start", uid=user["id"], name=user["name"], sid=sid, visit=1, ip=ip)
        return user, None


# какое действие гостя создало аккаунт (поле trigger события account.create)
CREATE_TRIGGERS = {
    "rename_account": "rename",
    "change_password": "password",
    "create_board": "board_create",
    "save_board": "board_save",
    "delete_board": "board_delete",
    "save_boards_order": "board_order",
    "add_board_access": "board_share",
    "set_board_link": "board_share",
    "join_invite": "invite",
}
GUEST_ACTIONS = set(CREATE_TRIGGERS.values())


def guest_action(payload: dict) -> str:
    """Действие гостя из запроса (только из списка известных) или ""."""
    action = str(payload.get("action") or "")
    return action if action in GUEST_ACTIONS else ""


def client_ip() -> str:
    return request.remote_addr or "?"


# Ограничения частоты: не больше LIMIT событий за WINDOW секунд с одного адреса
LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW = 10, 15 * 60     # неудачные попытки входа
CREATE_LIMIT, CREATE_WINDOW = 20, 60 * 60             # создание пространств
_hits = {}
_hits_lock = threading.Lock()


def _recent_hits(kind: str, key: str, window: int) -> list:
    now = time.time()
    with _hits_lock:
        hits = [t for t in _hits.get((kind, key), []) if now - t < window]
        _hits[(kind, key)] = hits
        return hits


def is_limited(kind: str, key: str, limit: int, window: int) -> bool:
    return len(_recent_hits(kind, key, window)) >= limit


def add_hit(kind: str, key: str) -> None:
    with _hits_lock:
        _hits.setdefault((kind, key), []).append(time.time())


def prune_memory() -> None:
    """Удаляет из памяти устаревшие записи ограничителей частоты и ключей
    гостей — иначе они копились бы до перезапуска сервера."""
    now = time.time()
    longest = max(LOGIN_FAIL_WINDOW, CREATE_WINDOW)
    with _hits_lock:
        for key in list(_hits):
            hits = [t for t in _hits[key] if now - t < longest]
            if hits:
                _hits[key] = hits
            else:
                del _hits[key]
    with _guest_lock:
        for token in list(_guest_accounts):
            if now - _guest_accounts[token][1] > GUEST_ACCOUNT_TTL:
                del _guest_accounts[token]


def write_visit_end(data: dict) -> None:
    data = dict(data, started=local_iso(data["started"]), ended=local_iso(data["ended"]))
    events.write("visit.end", **data)


def _housekeeping(do_cleanup: bool) -> None:
    try:
        prune_memory()
        # заходы, в которых давно не было действий (в т.ч. оставшиеся
        # незакрытыми до перезапуска сервера), — закрываем
        for data in accounts.close_stale_visits():
            write_visit_end(data)
        if do_cleanup:
            for u in accounts.cleanup():
                events.write("account.delete", uid=u["id"], name=u["name"],
                             reason="cleanup", age_days=u["age_days"])
                # у удалённого аккаунта общих досок нет (иначе его бы не
                # удалили), но на всякий случай убираем его доступы
                shares.remove_user(u["id"])
            events.prune()
    except Exception as err:  # фоновая уборка не должна ронять сервер
        print("[accounts] ошибка чистки:", err)


# Уборка в фоне (запрос, который её запустил, её не ждёт): чистка памяти и
# закрытие заходов — раз в час (и при первом запросе после старта сервера),
# чистка пустых аккаунтов без пароля и старых файлов журнала — раз в сутки
_housekeeping_state = {"prune": 0.0, "cleanup": 0.0}
_housekeeping_lock = threading.Lock()


@app.before_request
def periodic_cleanup():
    now = time.time()
    if now - _housekeeping_state["prune"] < 60 * 60:
        return
    with _housekeeping_lock:
        if now - _housekeeping_state["prune"] < 60 * 60:
            return
        _housekeeping_state["prune"] = now
        do_cleanup = now - _housekeeping_state["cleanup"] > 24 * 60 * 60
        if do_cleanup:
            _housekeeping_state["cleanup"] = now
    threading.Thread(target=_housekeeping, args=(do_cleanup,), daemon=True).start()


# API (кроме входа) — для вошедших и гостей
PUBLIC_API = {"/api/login"}


@app.before_request
def require_login_for_api():
    if request.path.startswith("/api/") and request.path not in PUBLIC_API:
        if not current_user() and not session.get("guest"):
            return jsonify({"error": "auth"}), 401
    return None


@app.before_request
def track_activity():
    """Любой запрос вошедшего пользователя (страница или API) — действие:
    продлевает текущий заход или начинает новый (см. accounts.register_activity)."""
    if request.path.startswith("/static/"):
        return None
    # автообновление открытой доски (GET …?since=) — не действие пользователя:
    # иначе забытая открытая вкладка продлевала бы заход бесконечно
    if request.method == "GET" and "since" in request.args:
        return None
    user = current_user()
    if user:
        for event, data in accounts.register_activity(user["id"], session.get("sid", "")):
            if event == "visit.end":
                write_visit_end(data)
            else:
                events.write(event, **data, ip=client_ip())
    return None


def json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


# ---------------------------------------------------------------------------
# Страницы
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    if not current_user():
        # не вошли (новый посетитель, вышли, cookie устарела) — гость: пустое
        # пространство, аккаунт создастся при первом изменении
        start_guest()
    return render_page("index.html")


@app.route("/board/<board_id>")
@app.route("/board/<owner_id>/<board_id>")
def board_page(board_id, owner_id=""):
    """Своя доска — /board/<id>, чужая общая — /board/<id владельца>/<id>."""
    if not current_user() and not session.get("guest"):
        return redirect("/")
    # удалённая доска или доска, к которой нет доступа, — на стартовую страницу
    path, _ = resolve_board(board_id, owner_id)
    if not path:
        return redirect("/")
    return render_page("board.html")


@app.route("/login")
def login_page():
    # открывается и из пространства (кнопка «Войти») — вход в другое пространство
    # заменяет текущий вход в этом браузере
    return render_page("login.html")


# ---------------------------------------------------------------------------
# API: аккаунт
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Администраторы (страница статистики /admin)
# ---------------------------------------------------------------------------

# Логины администраторов — через запятую в переменной окружения KANBAN_ADMINS
# (KANBAN_ADMINS=alexey). Нужен заданный пароль: аккаунт без пароля
# администратором не считается.
ADMINS = {name_key(n) for n in os.environ.get("KANBAN_ADMINS", "").split(",") if n.strip()}


def is_admin(user) -> bool:
    return bool(user and user.get("password") and name_key(user["name"]) in ADMINS)


_stats_cache = {}
_stats_lock = threading.Lock()
STATS_CACHE_SECONDS = 5 * 60
STATS_PERIODS = (7, 30, 90)


@app.route("/admin")
def admin_page():
    # остальным — «страницы нет», а не «нет доступа»: не выдаём, что она есть
    if not is_admin(current_user()):
        abort(404)
    return render_page("admin.html")


@app.route("/api/admin/stats", methods=["GET"])
def admin_stats():
    if not is_admin(current_user()):
        abort(404)
    days = request.args.get("days", type=int) or 30
    if days not in STATS_PERIODS:
        days = 30
    fresh = request.args.get("fresh") == "1"
    now = time.time()
    with _stats_lock:
        cached = _stats_cache.get(days)
        if not fresh and cached and now - cached[0] < STATS_CACHE_SECONDS:
            data = cached[1]
        else:
            data = stats.compute(os.path.join(DATA_DIR, "logs"), days, accounts.all_users())
            _stats_cache[days] = (now, data)
    response = jsonify(data)
    response.headers["Cache-Control"] = "no-store"
    return response


def account_json(user: dict):
    return jsonify({
        "name": user["name"],
        "hasPassword": bool(user.get("password")),
        "canRename": not user.get("renamed"),
        "nameRules": NAME_RULES_TEXT,
        "passwordMin": PASSWORD_MIN,
        # напоминание «Задайте пароль…» — начиная с этого захода в аккаунт
        "visits": user.get("visits", VISITS_UNKNOWN),
        "passwordBannerFrom": PASSWORD_BANNER_FROM_VISIT,
        # пункт «Статистика» в меню аккаунта
        "isAdmin": is_admin(user),
    })


GUEST_NAME = "Гость"


@app.route("/api/account", methods=["GET"])
def get_account():
    user = current_user()
    if user:
        response = account_json(user)
    else:
        response = jsonify({
            "name": GUEST_NAME,
            "guest": True,
            "hasPassword": False,
            "canRename": True,
            "nameRules": NAME_RULES_TEXT,
            "passwordMin": PASSWORD_MIN,
        })
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/account/name", methods=["POST"])
def rename_account():
    payload = request.get_json(force=True, silent=True) or {}
    name = str(payload.get("name") or "").strip()
    user = current_user()
    if not user:
        # гость: аккаунт создаётся сразу с выбранным логином
        error = accounts.validate_name(name)
        if error:
            return json_error(error)
        # окно имени открылось перед другим действием (новая доска, правка…) —
        # в журнал пишем его, а не «смену логина»
        user, error_response = ensure_user(name, guest_action(payload))
        if error_response:
            return error_response
        return account_json(user)
    error = accounts.rename(user["id"], name)
    if error:
        return json_error(error)
    return account_json(accounts.get(user["id"]))


@app.route("/api/account/name-prompt", methods=["POST"])
def name_prompt():
    """Гостю показано окно имени (перед первым изменением). Только для
    журнала: guest.prompt пишется один раз на ключ гостя."""
    token = guest_token()
    if token and not session.get("prompted"):
        session["prompted"] = True
        payload = request.get_json(force=True, silent=True) or {}
        events.write("guest.prompt", gid=fingerprint(token),
                     action=guest_action(payload) or None, ip=client_ip(), ua=request_ua())
    return "", 204


@app.route("/api/account/password", methods=["POST"])
def change_password():
    user = current_user()
    payload = request.get_json(force=True, silent=True) or {}
    current = str(payload.get("current") or "")
    new = str(payload.get("password") or "")
    if user and user.get("password"):
        ip = client_ip()
        if is_limited("login", ip, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW):
            return json_error("Слишком много попыток. Попробуйте через 15 минут.", 429)
        if not accounts.check_password(user, current):
            add_hit("login", ip)
            return json_error("Текущий пароль указан неверно.")
    if len(new) < PASSWORD_MIN:
        return json_error(f"Пароль должен быть не короче {PASSWORD_MIN} символов.")
    if len(new) > PASSWORD_MAX:
        return json_error(f"Пароль должен быть не длиннее {PASSWORD_MAX} символов.")
    if not user:
        # гость: пароль подходит — создаём аккаунт
        user, error_response = ensure_user()
        if error_response:
            return error_response
    # версия сессий растёт — все остальные устройства выходят из аккаунта,
    # а это устройство получает новую cookie и остаётся в аккаунте
    new_ver = accounts.set_password(user["id"], new)
    updated = accounts.get(user["id"])
    updated["ver"] = new_ver
    start_session(updated, "password", session.get("sid", ""))
    return account_json(updated)


@app.route("/api/login", methods=["POST"])
def login():
    ip = client_ip()
    payload = request.get_json(force=True, silent=True) or {}
    entered = str(payload.get("name") or "")
    if is_limited("login", ip, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW):
        # в журнал — один раз за окно блокировки, иначе перебором можно раздуть файл
        if not is_limited("login_limited_logged", ip, 1, LOGIN_FAIL_WINDOW):
            add_hit("login_limited_logged", ip)
            events.write("login.fail", name=entered[:40], reason="rate_limited", ip=ip, ua=request_ua())
        return json_error("Слишком много попыток входа. Попробуйте через 15 минут.", 429)
    user = accounts.find_by_name(entered)
    if not user or not accounts.check_password(user, str(payload.get("password") or "")):
        add_hit("login", ip)
        reason = "no_user" if not user else ("bad_password" if user.get("password") else "no_password")
        events.write("login.fail", name=entered[:40], reason=reason, ip=ip, ua=request_ua())
        # одно сообщение для всех случаев — не подсказываем, какие логины существуют
        return json_error("Неверный логин или пароль.")
    start_session(user, "login")
    return jsonify({"status": "ok"})


@app.route("/api/logout", methods=["POST"])
def logout():
    user = current_user()
    if user:
        events.write("session.end", uid=user["id"], name=user["name"], sid=session.get("sid"),
                     reason="logout", ip=client_ip())
    session.clear()
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# API: список досок
# ---------------------------------------------------------------------------

def board_summary(board_id: str, path: str):
    """Данные доски для плитки на стартовой странице (или None, если файла нет)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = parse_board(f.read())
    except OSError:
        return None
    return {
        "id": board_id,
        "title": data.get("title") or DEFAULT_BOARD_TITLE,
        "background": data.get("background") or "",
        "columns_count": len(data.get("columns", [])),
        # для плитки на стартовой: всего задач и разбивка по столбцам
        "tasks_count": sum(len(c.get("cards", [])) for c in data.get("columns", [])),
        "columns": [
            {"title": c.get("title", ""), "count": len(c.get("cards", []))}
            for c in data.get("columns", [])
        ],
        "_created": data.get("created") or "",
    }


def shared_with_me() -> list:
    """Чужие доски, открытые текущему пользователю (раздел «Доступные мне»),
    в порядке, в котором открывали доступ."""
    user = current_user()
    if not user:
        return []
    result = []
    for s in shares.boards_for(user["id"]):
        owner = accounts.get(s["owner"])
        if not owner:
            continue
        path = os.path.join(accounts.user_dir(owner["id"]), f"{s['board']}.txt")
        summary = board_summary(s["board"], path)
        if not summary:
            continue
        del summary["_created"]
        summary["owner"] = owner["id"]
        summary["ownerName"] = owner["name"]
        result.append(summary)
    return result


@app.route("/api/boards", methods=["GET"])
def list_boards():
    folder = user_boards_dir()  # у гостя — шаблонные доски
    user = current_user()
    share_counts = shares.counts_for_owner(user["id"]) if user else {}
    boards = []
    for filename in os.listdir(folder):
        if not filename.endswith(".txt"):
            continue
        board_id = filename[:-4]
        if not is_valid_board_id(board_id):
            continue
        summary = board_summary(board_id, os.path.join(folder, filename))
        if summary:
            # скольким пользователям владелец открыл доску (значок на плитке)
            summary["sharedWith"] = share_counts.get(board_id, 0)
            boards.append(summary)

    # Порядок досок по умолчанию: сначала старые доски без даты создания
    # (по алфавиту), затем доски с датой создания — от старых к новым.
    boards.sort(key=lambda b: (b["_created"] != "", b["_created"], b["title"].lower()))
    for b in boards:
        del b["_created"]

    # Если порядок уже задан перетаскиванием — доски из файла порядка идут
    # первыми в сохранённом порядке, остальные (например, только что
    # созданные) — после них, в порядке по умолчанию.
    order = {board_id: i for i, board_id in enumerate(read_board_order())}
    if order:
        boards.sort(key=lambda b: (0, order[b["id"]]) if b["id"] in order else (1, 0))
    response = jsonify({"boards": boards, "shared": shared_with_me()})
    # список досок всегда должен быть свежим (не из кэша браузера)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/boards", methods=["POST"])
def create_board():
    # гость: первая доска создаёт аккаунт
    user, error_response = ensure_user()
    if error_response:
        return error_response
    payload = request.get_json(force=True, silent=True) or {}
    title = str(payload.get("title") or "").strip() or DEFAULT_BOARD_TITLE

    board_id = str(uuid.uuid4())
    created = datetime.now().isoformat(timespec="seconds")
    text = serialize_board({"title": title, "created": created, "columns": []})
    write_text_atomic(board_file_path(board_id), text)

    # новая доска всегда добавляется в конец списка
    order = read_board_order()
    if order:
        write_board_order(order + [board_id])

    return jsonify({"id": board_id, "title": title})


@app.route("/api/boards/<board_id>", methods=["DELETE"])
def delete_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    if not os.path.exists(board_file_path(board_id)):
        return jsonify({"status": "ok"})
    # гость: удаление шаблонной доски — изменение, сначала создаётся аккаунт
    user, error_response = ensure_user()
    if error_response:
        return error_response
    path = board_file_path(board_id)
    if os.path.exists(path):
        os.remove(path)
    # удалить доску может только владелец — у всех, кому она была открыта, она пропадает
    for s in shares.remove_board(user["id"], board_id):
        events.write("board.unshare", uid=user["id"], name=user["name"], board=board_id,
                     to_uid=s["user"], reason="board_delete", ip=client_ip())
    order = read_board_order()
    if board_id in order:
        write_board_order([i for i in order if i != board_id])
    return jsonify({"status": "ok"})


@app.route("/api/boards/order", methods=["POST"])
def save_boards_order():
    payload = request.get_json(force=True, silent=True) or {}
    ids = payload.get("ids")
    if not isinstance(ids, list):
        return jsonify({"error": "ids must be a list"}), 400
    # гость: перестановка досок — изменение, сначала создаётся аккаунт
    user, error_response = ensure_user()
    if error_response:
        return error_response
    # сохраняем только существующие доски
    ids = [i for i in ids if is_valid_board_id(str(i)) and os.path.exists(board_file_path(str(i)))]
    write_board_order(ids)
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# API: содержимое одной доски
# ---------------------------------------------------------------------------

# Чтение-изменение-запись файла доски — под блокировкой этого файла: два
# сохранения одной доски (общие доски) не должны перемешаться.
_board_locks = {}
_board_locks_guard = threading.Lock()


def board_lock(path: str) -> threading.Lock:
    with _board_locks_guard:
        lock = _board_locks.get(path)
        if lock is None:
            lock = _board_locks[path] = threading.Lock()
        return lock


def read_board_file(path: str) -> dict:
    """Читает доску; если в файле ещё нет id столбцов и карточек (старый файл) —
    дописывает их, чтобы у всех, кто открыл доску, id совпадали. Под board_lock."""
    with open(path, "r", encoding="utf-8") as f:
        data = parse_board(f.read())
    if data.pop("missingIds", False) and not path.startswith(TEMPLATES_DIR + os.sep):
        write_text_atomic(path, serialize_board(data))
    return data


@app.route("/api/board/<board_id>", methods=["GET"])
def get_board(board_id):
    """Доска целиком. ?since=<версия> — для автообновления открытой доски:
    если версия не изменилась, в ответе только {"unchanged": true, "revision"}."""
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    path, owner_id = resolve_board(board_id, request_owner())
    if not path:
        # доска удалена или к ней нет доступа (в том числе доступ закрыли)
        return jsonify({"error": "not found"}), 404
    with board_lock(path):
        data = read_board_file(path)
    since = request.args.get("since", type=int)
    if since is not None and since == data["revision"]:
        response = jsonify({"unchanged": True, "revision": since})
    else:
        data["access"] = access_info(board_id, owner_id)
        response = jsonify(data)
    response.headers["Cache-Control"] = "no-store"
    return response


def normalize_board(data) -> dict:
    """Доска от браузера — в том виде, в каком её читает сервер (чистые
    значения, id у всех столбцов и карточек)."""
    if not isinstance(data, dict):
        data = {}
    clean = parse_board(serialize_board(data))
    clean.pop("missingIds", None)
    return clean


@app.route("/api/board/<board_id>", methods=["POST"])
def save_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    if not current_user():
        # гость: сохранение шаблонной доски — первое изменение, создаём аккаунт
        # (шаблоны копируются в него с теми же id) и сохраняем уже его копию
        if request_owner() or not os.path.exists(board_file_path(board_id)):
            return jsonify({"error": "not found"}), 404
        user, error_response = ensure_user()
        if error_response:
            return error_response
    payload = request.get_json(force=True, silent=True) or {}
    # Браузер присылает доску целиком (board), версию, от которой начал правку
    # (baseRevision), и саму эту версию (base). Если с тех пор доску сохранил
    # кто-то другой, его изменения не затираются: три версии сливаются (merge.py).
    mine = payload.get("board") if isinstance(payload.get("board"), dict) else payload
    base = payload.get("base") if isinstance(payload.get("base"), dict) else None
    base_revision = payload.get("baseRevision")
    if mine is payload:
        # старый формат запроса — доска без обёртки
        for extra in ("access", "base", "baseRevision"):
            mine.pop(extra, None)
    # своя доска или чужая, к которой открыт доступ (права у всех одни:
    # смотреть и править)
    path, _ = resolve_board(board_id, request_owner())
    if not path:
        return jsonify({"error": "not found"}), 404
    with board_lock(path):
        current = read_board_file(path)
        existing_labels = {t["key"]: t["label"] for t in current.get("tagDefs", [])}
        # Лимит длины названия тега: новые и изменённые названия обрезаются,
        # уже сохранённые (неизменённые) — остаются как есть.
        tag_defs = mine.get("tagDefs")
        if isinstance(tag_defs, list):
            for t in tag_defs:
                if not isinstance(t, dict):
                    continue
                label = str(t.get("label", "") or "").strip()
                if existing_labels.get(t.get("key")) != label:
                    t["label"] = label[:TAG_LABEL_MAX].strip()
        mine = normalize_board(mine)
        merged = base is not None and base_revision != current["revision"]
        result = merge_boards(normalize_board(base), mine, current) if merged else mine
        # дату создания и версию задаёт только сервер
        result["created"] = current.get("created", "")
        result["revision"] = current["revision"] + 1
        write_text_atomic(path, serialize_board(result))
    response = {"status": "ok", "revision": result["revision"]}
    if merged:
        # в доске есть и чужие изменения — браузеру нужна итоговая версия
        response["merged"] = True
        response["board"] = result
    return jsonify(response)


# ---------------------------------------------------------------------------
# API: доступ к доске (общие доски)
# ---------------------------------------------------------------------------

# Поиск пользователя по логину, чтобы открыть ему доступ: не больше стольких
# неудачных попыток (логин не найден) за окно — иначе можно перебором
# выяснять, какие логины существуют
SHARE_LOOKUP_LIMIT, SHARE_LOOKUP_WINDOW = 30, 15 * 60


def access_info(board_id: str, owner_id: str) -> dict:
    """Кто имеет доступ к доске: владелец и те, кому он её открыл.
    owner_id — "" для своей доски (или шаблонной доски гостя)."""
    user = current_user()
    me = user["id"] if user else ""
    owner = accounts.get(owner_id) if owner_id else user
    owner_key = owner["id"] if owner else ""
    users = []
    for s in shares.users_for(owner_key, board_id) if owner_key else []:
        u = accounts.get(s["user"])
        if u:
            users.append({"id": u["id"], "name": u["name"], "me": u["id"] == me})
    info = {
        "isOwner": not owner_id,
        "owner": {"id": owner_key, "name": owner["name"] if owner else GUEST_NAME,
                  "me": not owner_id},
        "users": users,
    }
    if not owner_id:
        # ссылку-приглашение видит только владелец
        token = shares.link_for(owner_key, board_id) if owner_key else None
        info["link"] = f"/invite/{token}" if token else None
    return info


@app.route("/api/board/<board_id>/access", methods=["GET"])
def get_board_access(board_id):
    path, owner_id = resolve_board(board_id, request_owner())
    if not path:
        return jsonify({"error": "not found"}), 404
    response = jsonify(access_info(board_id, owner_id))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/board/<board_id>/access", methods=["POST"])
def add_board_access(board_id):
    """Открыть доступ к своей доске пользователю с указанным логином.
    Открывать доступ может только владелец доски."""
    if request_owner() and not (current_user() and request_owner() == current_user()["id"]):
        return json_error("Открыть доступ к доске может только её владелец.", 403)
    path, _ = resolve_board(board_id)
    if not path:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return json_error("Введите логин пользователя.")
    # гость: открыть доступ к шаблонной доске — изменение, сначала создаётся
    # аккаунт (шаблоны копируются в него с теми же id)
    user, error_response = ensure_user()
    if error_response:
        return error_response
    if not os.path.exists(board_file_path(board_id)):
        return jsonify({"error": "not found"}), 404
    ip = client_ip()
    if is_limited("share_lookup", user["id"], SHARE_LOOKUP_LIMIT, SHARE_LOOKUP_WINDOW):
        return json_error("Слишком много попыток. Попробуйте через 15 минут.", 429)
    target = accounts.find_by_lookalike(name)
    if not target:
        add_hit("share_lookup", user["id"])
        return json_error("Пользователь с таким логином не найден.")
    if target["id"] == user["id"]:
        return json_error("Это ваш логин — доска и так ваша.")
    if not shares.add(user["id"], board_id, target["id"]):
        return json_error(f"У пользователя {target['name']} уже есть доступ.")
    events.write("board.share", uid=user["id"], name=user["name"], board=board_id,
                 to_uid=target["id"], to_name=target["name"], ip=ip)
    return jsonify(access_info(board_id, ""))


@app.route("/api/board/<board_id>/access/<user_id>", methods=["DELETE"])
def remove_board_access(board_id, user_id):
    """Закрыть доступ. Владелец может закрыть доступ любому; получатель —
    только себе (убрать чужую доску у себя из списка)."""
    user = current_user()
    if not user:
        return jsonify({"error": "not found"}), 404
    if user_id == "me":
        user_id = user["id"]
    owner_id = request_owner() or user["id"]
    if owner_id != user["id"] and user_id != user["id"]:
        return json_error("Закрыть доступ другим может только владелец доски.", 403)
    if not is_valid_board_id(board_id) or not is_valid_board_id(user_id):
        return jsonify({"error": "invalid id"}), 400
    if shares.remove(owner_id, board_id, user_id):
        owner = accounts.get(owner_id)
        events.write("board.unshare", uid=owner_id, name=owner["name"] if owner else None,
                     board=board_id, to_uid=user_id,
                     reason="owner" if owner_id == user["id"] else "leave", ip=client_ip())
    if owner_id != user["id"]:
        return jsonify({"status": "ok"})
    return jsonify(access_info(board_id, ""))


@app.route("/api/board/<board_id>/link", methods=["POST"])
def set_board_link(board_id):
    """Включить ссылку-приглашение на свою доску ({"reset": true} — выдать
    новую ссылку вместо старой: старая перестаёт работать, а доступ, уже
    полученный по ней, остаётся)."""
    if request_owner() and not (current_user() and request_owner() == current_user()["id"]):
        return json_error("Ссылкой на доску управляет только её владелец.", 403)
    path, _ = resolve_board(board_id)
    if not path:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    # гость: ссылка — изменение, сначала создаётся аккаунт
    user, error_response = ensure_user()
    if error_response:
        return error_response
    if not os.path.exists(board_file_path(board_id)):
        return jsonify({"error": "not found"}), 404
    existing = shares.link_for(user["id"], board_id)
    if not existing or payload.get("reset"):
        shares.set_link(user["id"], board_id)
        events.write("board.link", uid=user["id"], name=user["name"], board=board_id,
                     action="reset" if existing else "create", ip=client_ip())
    return jsonify(access_info(board_id, ""))


@app.route("/api/board/<board_id>/link", methods=["DELETE"])
def disable_board_link(board_id):
    """Выключить ссылку-приглашение (доступ, уже полученный по ней, остаётся)."""
    user = current_user()
    if not user or (request_owner() and request_owner() != user["id"]):
        return json_error("Ссылкой на доску управляет только её владелец.", 403)
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    if shares.disable_link(user["id"], board_id):
        events.write("board.link", uid=user["id"], name=user["name"], board=board_id,
                     action="off", ip=client_ip())
    return jsonify(access_info(board_id, ""))


# ---------------------------------------------------------------------------
# Ссылка-приглашение: /invite/<секрет>
# ---------------------------------------------------------------------------

def invite_target(token: str):
    """Доска по ссылке-приглашению: (владелец, id доски, путь к файлу) или None,
    если ссылка выключена, сброшена или доски уже нет."""
    link = shares.find_link(token)
    if not link:
        return None
    owner = accounts.get(link["owner"])
    if not owner:
        return None
    path = os.path.join(accounts.user_dir(owner["id"]), f"{link['board']}.txt")
    if not os.path.exists(path):
        return None
    return owner, link["board"], path


def join_by_invite(user: dict, token: str):
    """Открывает пользователю доступ по ссылке. Возвращает адрес доски или None."""
    target = invite_target(token)
    if not target:
        return None
    owner, board_id, _ = target
    if owner["id"] == user["id"]:
        return f"/board/{board_id}"  # своя доска
    if shares.add(owner["id"], board_id, user["id"]):
        events.write("board.share", uid=owner["id"], name=owner["name"], board=board_id,
                     to_uid=user["id"], to_name=user["name"], via="link", ip=client_ip())
    return f"/board/{owner['id']}/{board_id}"


@app.route("/invite/<token>")
def invite_page(token):
    user = current_user()
    if user:
        # вошедший пользователь сразу получает доступ и попадает на доску
        url = join_by_invite(user, token)
        return redirect(url or "/?invite=invalid")
    # гость (или новый посетитель): страница приглашения — сначала нужно имя
    start_guest()
    return render_page("invite.html")


@app.route("/api/invite/<token>", methods=["GET"])
def get_invite(token):
    """Что за доска по ссылке — для страницы приглашения."""
    target = invite_target(token)
    if not target:
        return jsonify({"error": "not found"}), 404
    owner, board_id, path = target
    summary = board_summary(board_id, path) or {}
    response = jsonify({"ownerName": owner["name"],
                        "title": summary.get("title") or DEFAULT_BOARD_TITLE})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/invite/<token>", methods=["POST"])
def join_invite(token):
    """Принять приглашение: гостю сначала создаётся аккаунт (окно имени
    показывает страница приглашения), затем открывается доступ."""
    if not invite_target(token):
        return json_error("Ссылка больше не действует. Попросите владельца доски прислать новую.", 404)
    user, error_response = ensure_user()
    if error_response:
        return error_response
    url = join_by_invite(user, token)
    if not url:
        return json_error("Ссылка больше не действует. Попросите владельца доски прислать новую.", 404)
    return jsonify({"url": url})


if __name__ == "__main__":
    # Настройки запуска — переменными окружения:
    #   KANBAN_HOST    — адрес (по умолчанию 127.0.0.1 — только этот компьютер;
    #                    0.0.0.0 — доступно из сети)
    #   KANBAN_PORT    — порт (по умолчанию 5050)
    #   KANBAN_THREADS — сколько запросов обрабатывать одновременно (по умолчанию 16)
    #   KANBAN_DEBUG=1 — режим разработки Flask (автоперезапуск при правке кода,
    #                    отладчик в браузере). Только на своём компьютере: через
    #                    отладчик можно выполнить любой код на сервере.
    host = os.environ.get("KANBAN_HOST", "127.0.0.1")
    port = int(os.environ.get("KANBAN_PORT", "5050"))
    if os.environ.get("KANBAN_DEBUG") == "1":
        app.run(debug=True, host=host, port=port)
    else:
        try:
            from waitress import serve
        except ImportError:
            print("[server] waitress не установлен (pip3 install waitress) — "
                  "запускаю встроенный сервер Flask, он годится только для проверки")
            app.run(host=host, port=port, threaded=True)
        else:
            threads = int(os.environ.get("KANBAN_THREADS", "16"))
            print(f"[server] http://{host}:{port} (waitress, потоков: {threads})")
            serve(app, host=host, port=port, threads=threads)
