"""
Простой Flask-сервер для канбан-доски (поддержка нескольких досок).

- Отдаёт index.html (стартовая страница со списком досок) и board.html
  (страница одной доски); CSS и JS лежат отдельно в папке static/.
- Каждая доска хранится в своём текстовом файле в папке Data,
  имя файла — GUID, например Data/3fa85f64-5717-4562-b3fc-2c963f66afa6.txt.
  Сколько файлов в папке Data — столько досок отображается на стартовой странице.

- GET    /api/boards            — список всех досок (id + название)
- POST   /api/boards             — создать новую доску, возвращает её id
- DELETE /api/boards/<id>        — удалить доску (удаляет файл)
- GET    /api/board/<id>         — прочитать содержимое доски
- POST   /api/board/<id>         — сохранить (перезаписать) содержимое доски

Данные хранятся в человекочитаемом текстовом файле (см. формат ниже),
а не в базе данных — по условию задачи.
"""

import os
import re
import uuid
from flask import Flask, Response, request, jsonify, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Папка с данными всегда лежит рядом с app.py. У каждой доски свой файл
# внутри неё, имя файла — GUID, например 3fa85f64-...-2c963f66afa6.txt
DATA_DIR = os.path.join(BASE_DIR, "Data")

app = Flask(__name__, static_folder="static", static_url_path="/static")

# Браузер не должен держать CSS/JS в кэше без проверки: в старых версиях Flask
# по умолчанию разрешено кэшировать статику на 12 часов, и после правок
# в браузере оставалось старое поведение.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

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


def board_file_path(board_id: str) -> str:
    return os.path.join(DATA_DIR, f"{board_id}.txt")


# ---------------------------------------------------------------------------
# Формат текстового файла одной доски (человекочитаемый, с явными границами блоков):
#
#   # Kanban board data file
#   TITLE: Название доски
#   BACKGROUND: blue
#
#   TAGDEFS
#   TAGDEF key=yellow color=yellow label=желтый
#   TAGDEF key=tag-1a2b3c color=purple label=Моя метка
#   ENDTAGDEFS
#
#   COLUMN: Название столбца
#   CARD priority=medium tags=yellow,tag-1a2b3c
#   Текст карточки.
#   Может быть
#   многострочным.
#   ENDCARD
#   CARD priority=critical
#   Другая карточка
#   ENDCARD
#   ENDCOLUMN
#
#   COLUMN: Следующий столбец
#   ENDCOLUMN
#
# Строка BACKGROUND необязательна: если её нет — у доски обычный фон.
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

# Цвета фона доски (совпадают со списком в static/board-bg.js).
# Пустая строка — обычный фон (по умолчанию).
BACKGROUND_KEYS = {"blue", "green", "purple", "red", "yellow"}


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


def parse_board(text: str) -> dict:
    """Разбирает содержимое файла доски в структуру
    {"title": ..., "background": ..., "columns": [...], "tagDefs": [...]}."""
    board_title = DEFAULT_BOARD_TITLE
    background = ""
    columns = []
    current_column = None
    card_lines = None
    card_priority = DEFAULT_PRIORITY
    card_tags = []

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
                        {"text": card_text, "priority": card_priority, "tags": card_tags}
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
        elif stripped.startswith("BACKGROUND:"):
            background = normalize_background(stripped[len("BACKGROUND:"):])
        elif stripped.startswith("COLUMN:"):
            title = stripped[len("COLUMN:"):].strip()
            current_column = {"title": title, "cards": []}
            columns.append(current_column)
        elif stripped == "ENDCOLUMN":
            current_column = None
        elif stripped.startswith("CARD"):
            match = re.search(r"priority=(\w+)", stripped)
            priority = match.group(1) if match else DEFAULT_PRIORITY
            if priority not in PRIORITY_VALUES:
                priority = DEFAULT_PRIORITY
            card_priority = priority

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
        "columns": columns,
        "tagDefs": tag_defs,
    }


def serialize_board(data: dict) -> str:
    """Собирает структуру {"title": ..., "background": ..., "columns": [...], "tagDefs": [...]}
    обратно в текст файла доски."""
    board_title = str(data.get("title", "") or "").replace("\n", " ").strip() or DEFAULT_BOARD_TITLE
    background = normalize_background(data.get("background"))

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
        "#         BACKGROUND: <blue|green|purple|red|yellow> (необязательно, без строки — обычный фон)",
        "#         TAGDEFS ... TAGDEF key=<ключ> color=<цвет> label=<название> ... ENDTAGDEFS",
        "#         COLUMN: <название> ... CARD priority=<critical|medium|minor> [tags=<ключ1,ключ2,...>] текст ENDCARD ... ENDCOLUMN",
        "#         Доступные цвета: red, green, yellow, blue, gray, brown, purple, cyan, pink, lime",
        f"TITLE: {board_title}",
    ]
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

    for column in data.get("columns", []):
        title = str(column.get("title", "")).replace("\n", " ").strip()
        lines.append(f"COLUMN: {title}")
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

            card_header = f"CARD priority={priority}"
            if tags:
                card_header += f" tags={','.join(tags)}"
            lines.append(card_header)
            text = str(card.get("text", ""))
            lines.extend(text.split("\n"))
            lines.append("ENDCARD")
        lines.append("ENDCOLUMN")
        lines.append("")

    return "\n".join(lines).rstrip("\n") + "\n"


def migrate_legacy_file():
    """Если ещё остался старый единственный файл Data/data.txt (до введения
    множества досок) — переносим его в новый файл с GUID, чтобы не потерять данные."""
    legacy_path = os.path.join(DATA_DIR, "data.txt")
    if os.path.exists(legacy_path):
        new_path = board_file_path(str(uuid.uuid4()))
        os.rename(legacy_path, new_path)


# ---------------------------------------------------------------------------
# Страницы
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_page("index.html")


@app.route("/board/<board_id>")
def board_page(board_id):
    return render_page("board.html")


# ---------------------------------------------------------------------------
# API: список досок
# ---------------------------------------------------------------------------

@app.route("/api/boards", methods=["GET"])
def list_boards():
    os.makedirs(DATA_DIR, exist_ok=True)
    boards = []
    for filename in os.listdir(DATA_DIR):
        if not filename.endswith(".txt"):
            continue
        board_id = filename[:-4]
        if not is_valid_board_id(board_id):
            continue
        path = os.path.join(DATA_DIR, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        data = parse_board(text)
        boards.append({
            "id": board_id,
            "title": data.get("title") or DEFAULT_BOARD_TITLE,
            "background": data.get("background") or "",
            "columns_count": len(data.get("columns", [])),
        })

    boards.sort(key=lambda b: b["title"].lower())
    response = jsonify({"boards": boards})
    # список досок всегда должен быть свежим (не из кэша браузера)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/boards", methods=["POST"])
def create_board():
    payload = request.get_json(force=True, silent=True) or {}
    title = str(payload.get("title") or "").strip() or DEFAULT_BOARD_TITLE

    os.makedirs(DATA_DIR, exist_ok=True)
    board_id = str(uuid.uuid4())
    text = serialize_board({"title": title, "columns": []})
    with open(board_file_path(board_id), "w", encoding="utf-8") as f:
        f.write(text)

    return jsonify({"id": board_id, "title": title})


@app.route("/api/boards/<board_id>", methods=["DELETE"])
def delete_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    path = board_file_path(board_id)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# API: содержимое одной доски
# ---------------------------------------------------------------------------

@app.route("/api/board/<board_id>", methods=["GET"])
def get_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    path = board_file_path(board_id)
    if not os.path.exists(path):
        return jsonify({
            "title": DEFAULT_BOARD_TITLE,
            "columns": [],
            "tagDefs": [dict(t) for t in DEFAULT_TAG_DEFS],
        })
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    return jsonify(parse_board(text))


@app.route("/api/board/<board_id>", methods=["POST"])
def save_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    payload = request.get_json(force=True, silent=True) or {}
    os.makedirs(DATA_DIR, exist_ok=True)
    text = serialize_board(payload)
    with open(board_file_path(board_id), "w", encoding="utf-8") as f:
        f.write(text)
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    migrate_legacy_file()
    app.run(debug=True, port=5050)
