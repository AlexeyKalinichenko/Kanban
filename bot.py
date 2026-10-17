"""
Telegram-бот для просмотра досок (только просмотр, личный чат с ботом).

Отдельный процесс рядом с приложением: опрашивает Telegram (long polling,
webhook и открытый порт не нужны), а доски берёт только через API приложения
(/api/bot/…, см. app.py) — файлы в Data/ бот не читает и не пишет.

Подключение: кнопка «Telegram» на стартовой странице → ссылка
t.me/<бот>?start=<токен> → «Запустить» → бот отправляет токен приложению
и показывает список досок.

Запуск:  python3 bot.py
Переменные окружения:
  TELEGRAM_BOT_TOKEN — токен бота от @BotFather (обязательно)
  KANBAN_BOT_SECRET  — общий секрет с приложением (обязательно, тот же, что у app.py)
  KANBAN_URL         — адрес приложения (по умолчанию http://127.0.0.1:5050)
Зависимость: pip3 install "python-telegram-bot>=21,<23"

Кнопки (callback_data, не больше 64 байт):
  l                                   — список досок
  v:<доска>:<владелец>:<стр>:<версия>  — открыть доску из списка (пишется в журнал)
  p:…                                 — листание страниц
  r:…                                 — «Обновить» (та же версия — «Без изменений»)
  <доска> — id без дефисов (32 символа), <владелец> — первые 8 символов id
  владельца или «-» (своя доска).
"""

import html
import logging
import os
import sys
from datetime import datetime

import httpx
from telegram import (BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update)
from telegram.constants import ChatType, ParseMode
from telegram.error import BadRequest, Forbidden, TelegramError
from telegram.ext import (Application, CallbackQueryHandler, ChatMemberHandler, CommandHandler,
                          ContextTypes, MessageHandler, filters)

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
BOT_SECRET = os.environ.get("KANBAN_BOT_SECRET", "").strip()
KANBAN_URL = os.environ.get("KANBAN_URL", "http://127.0.0.1:5050").rstrip("/")

# Сколько видимых символов помещаем на одну страницу (лимит Telegram — 4096,
# запас — на шапку страницы)
PAGE_LIMIT = 3800
# Длинная карточка режется на куски не длиннее стольких символов
CARD_CHUNK = 3000
# Не больше стольких кнопок досок в списке (лимит Telegram — около 100 кнопок)
LIST_MAX = 90

PRIORITY_ICONS = {"critical": "🔴", "medium": "🟡", "minor": "⚪"}
# Цвета меток (палитра приложения, 10 цветов) → ближайший кружок-эмодзи
TAG_ICONS = {
    "red": "🔴", "green": "🟢", "yellow": "🟡", "blue": "🔵", "gray": "⚪",
    "brown": "🟤", "purple": "🟣", "cyan": "🔵", "pink": "🟣", "lime": "🟢",
}
TAG_ICON_DEFAULT = "🏷"

TEXT_NOT_LINKED = "Подключитесь заново кнопкой «Telegram» на стартовой странице приложения."
TEXT_NEVER_LINKED = ("Здесь можно смотреть свои доски. Чтобы подключиться, нажмите кнопку "
                     "«Telegram» на стартовой странице приложения.")
TEXT_UNAVAILABLE = "Не удалось получить доски, попробуйте позже."
TEXT_BAD_TOKEN = "Ссылка устарела — нажмите кнопку «Telegram» на стартовой странице ещё раз."
TEXT_HELP = ("Я показываю ваши доски из приложения (только просмотр).\n\n"
             "/boards — список досок\n"
             "/logout — отключить Telegram от аккаунта\n"
             "/help — эта подсказка")

log = logging.getLogger("kanban-bot")


# ---------------------------------------------------------------------------
# API приложения
# ---------------------------------------------------------------------------

class AppUnavailable(Exception):
    """Приложение не ответило или ответило ошибкой."""


class KanbanApi:
    def __init__(self, base_url: str, secret: str):
        self.client = httpx.AsyncClient(base_url=base_url, timeout=10,
                                        headers={"X-Bot-Secret": secret})

    async def _call(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.HTTPError as err:
            raise AppUnavailable(str(err)) from err
        if response.status_code != 200:
            raise AppUnavailable(f"{path}: HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as err:
            raise AppUnavailable(f"{path}: не JSON") from err

    async def link(self, token: str, tg_id: int, tg_username: str) -> dict:
        return await self._call("POST", "/api/bot/link", json={
            "token": token, "tg_id": str(tg_id), "tg_username": tg_username or ""})

    async def unlink(self, tg_id: int) -> dict:
        return await self._call("POST", "/api/bot/unlink", json={"tg_id": str(tg_id)})

    async def boards(self, tg_id: int) -> dict:
        return await self._call("GET", "/api/bot/boards", params={"tg_id": str(tg_id)})

    async def board(self, tg_id: int, board: str, owner: str, view: bool) -> dict:
        params = {"tg_id": str(tg_id), "board": board, "owner": "" if owner == "-" else owner}
        if view:
            params["view"] = "1"
        return await self._call("GET", "/api/bot/board", params=params)


# ---------------------------------------------------------------------------
# Оформление сообщений
# ---------------------------------------------------------------------------

def esc(text) -> str:
    return html.escape(str(text or ""), quote=False)


def visible_len(text: str) -> int:
    """Длина так, как её считает Telegram (UTF-16)."""
    return len(text.encode("utf-16-le")) // 2


BOLD_MARK = "**"


def rich_line(line: str):
    """Строка карточки: **жирное** — в <b>, как в приложении (static/board.js,
    richLineSegments: маркеры парные в пределах строки, лишний — как текст).
    Возвращает (HTML, видимый текст)."""
    parts = line.split(BOLD_MARK)
    if len(parts) % 2 == 0:
        last = parts.pop()
        parts[-1] += BOLD_MARK + last
    html_parts, plain_parts = [], []
    for i, text in enumerate(parts):
        if not text:
            continue
        plain_parts.append(text)
        html_parts.append(f"<b>{esc(text)}</b>" if i % 2 else esc(text))
    return "".join(html_parts), "".join(plain_parts)


def rich_text(text: str):
    lines = [rich_line(line) for line in text.split("\n")]
    return "\n".join(h for h, _ in lines), "\n".join(p for _, p in lines)


class Block:
    """Кусок текста страницы: HTML и его видимая длина (без разметки)."""

    def __init__(self, html_text: str, plain: str):
        self.html = html_text
        self.size = visible_len(plain)


def card_blocks(card: dict) -> list:
    """Карточка: значок приоритета + текст, строкой ниже — метки.
    Слишком длинный текст режется на несколько блоков."""
    icon = PRIORITY_ICONS.get(card.get("priority"), "")
    text = str(card.get("text") or "").strip("\n") or "—"
    chunks = [text[i:i + CARD_CHUNK] for i in range(0, len(text), CARD_CHUNK)]
    tags = card.get("tags") or []
    tags_plain = " · ".join(f"{TAG_ICON_DEFAULT} {t.get('name', '')}" for t in tags)
    tags_html = " · ".join(f"{TAG_ICONS.get(t.get('color'), TAG_ICON_DEFAULT)} {esc(t.get('name'))}"
                           for t in tags)
    blocks = []
    for i, chunk in enumerate(chunks):
        prefix = (icon + " ") if (i == 0 and icon) else ("… " if i else "")
        chunk_html, chunk_plain = rich_text(chunk)
        html_text, plain = prefix + chunk_html, prefix + chunk_plain
        if i == len(chunks) - 1 and tags:
            html_text += "\n" + tags_html
            plain += "\n" + tags_plain
        blocks.append(Block(html_text, plain))
    return blocks


def column_header(column: dict) -> Block:
    title = column.get("title") or "Без названия"
    count = len(column.get("cards") or [])
    return Block(f"<b>{esc(title)}</b> ({count})", f"{title} ({count})")


def column_blocks(column: dict) -> list:
    cards = column.get("cards") or []
    if not cards:
        return [Block("<i>Нет карточек</i>", "Нет карточек")]
    result = []
    for card in cards:
        result.extend(card_blocks(card))
    return result


def join_blocks(blocks: list, sep: str = "\n\n") -> str:
    return sep.join(b.html for b in blocks)


def total_size(blocks: list) -> int:
    return sum(b.size + 2 for b in blocks)


def build_pages(board: dict) -> list:
    """Страницы доски: [{"html", "label"}]. Вся доска помещается — одна
    страница. Иначе страница = столбец; длинный столбец делится на части."""
    columns = board.get("columns") or []
    if not columns:
        return [{"html": "<i>На доске пока нет столбцов</i>", "label": ""}]

    whole = []
    for column in columns:
        whole.append(column_header(column))
        whole.extend(column_blocks(column))
    if total_size(whole) <= PAGE_LIMIT:
        parts = []
        for column in columns:
            parts.append(column_header(column).html + "\n\n" + join_blocks(column_blocks(column)))
        return [{"html": "\n\n\n".join(parts), "label": ""}]

    pages = []
    for index, column in enumerate(columns, start=1):
        header = column_header(column)
        chunks, current, size = [], [], header.size
        for block in column_blocks(column):
            if current and size + block.size + 2 > PAGE_LIMIT:
                chunks.append(current)
                current, size = [], header.size
            current.append(block)
            size += block.size + 2
        chunks.append(current)
        for part, chunk in enumerate(chunks, start=1):
            label = f"Столбец {index} из {len(columns)}"
            if len(chunks) > 1:
                label += f" · часть {part} из {len(chunks)}"
            pages.append({"html": header.html + "\n\n" + join_blocks(chunk), "label": label})
    return pages


def board_message(board: dict, board_key: str, owner: str, page: int):
    """Текст и кнопки сообщения с доской. Возвращает (текст, клавиатура, страница)."""
    pages = build_pages(board)
    page = max(0, min(page, len(pages) - 1))
    current = pages[page]
    info = []
    if board.get("ownerName"):
        info.append(f"доска {board['ownerName']}")
    if current["label"]:
        info.append(current["label"])
    info.append("обновлено " + datetime.now().strftime("%H:%M"))
    text = f"<b>{esc(board.get('title'))}</b>\n<i>{esc(' · '.join(info))}</i>\n\n{current['html']}"

    revision = int(board.get("revision") or 0)
    ref = f"{board_key}:{owner}"
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("←", callback_data=f"p:{ref}:{page - 1}:{revision}"))
    nav.append(InlineKeyboardButton("Обновить", callback_data=f"r:{ref}:{page}:{revision}"))
    if page < len(pages) - 1:
        nav.append(InlineKeyboardButton("→", callback_data=f"p:{ref}:{page + 1}:{revision}"))
    keyboard = InlineKeyboardMarkup([nav, [InlineKeyboardButton("К списку досок", callback_data="l")]])
    return text, keyboard, page


def list_message(data: dict):
    """Список досок: свои, затем доступные мне (с логином владельца)."""
    boards = data.get("boards") or []
    name = data.get("name") or ""
    if not boards:
        return (f"Вы вошли как <b>{esc(name)}</b>.\n\nУ вас пока нет досок.",
                InlineKeyboardMarkup([[InlineKeyboardButton("Обновить", callback_data="l")]]))
    rows = []
    for b in boards[:LIST_MAX]:
        title = b.get("title") or "Доска"
        if b.get("owner"):
            title = f"👥 {title} · {b.get('ownerName', '')}"
        owner = b.get("owner") or "-"
        rows.append([InlineKeyboardButton(title[:60], callback_data=f"v:{b['id']}:{owner}:0:0")])
    text = f"Вы вошли как <b>{esc(name)}</b>.\n\nВыберите доску:"
    if len(boards) > LIST_MAX:
        text += f"\n<i>Показаны первые {LIST_MAX} из {len(boards)}.</i>"
    return text, InlineKeyboardMarkup(rows)


def back_to_list() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("К списку досок", callback_data="l")]])


# ---------------------------------------------------------------------------
# Обработчики
# ---------------------------------------------------------------------------

def api(context: ContextTypes.DEFAULT_TYPE) -> KanbanApi:
    return context.bot_data["api"]


async def send_list(update: Update, context: ContextTypes.DEFAULT_TYPE, prefix: str = "") -> None:
    user_id = update.effective_user.id
    try:
        data = await api(context).boards(user_id)
    except AppUnavailable as err:
        log.warning("приложение недоступно: %s", err)
        await update.effective_message.reply_text(TEXT_UNAVAILABLE)
        return
    if data.get("error") == "not_linked":
        await update.effective_message.reply_text((prefix + "\n\n" if prefix else "") + TEXT_NEVER_LINKED)
        return
    text, keyboard = list_message(data)
    if prefix:
        text = esc(prefix) + "\n\n" + text
    await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=keyboard)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    token = context.args[0] if context.args else ""
    if not token:
        await send_list(update, context)
        return
    user = update.effective_user
    try:
        result = await api(context).link(token, user.id, user.username or "")
    except AppUnavailable as err:
        log.warning("приложение недоступно: %s", err)
        await update.effective_message.reply_text(TEXT_UNAVAILABLE)
        return
    if result.get("error"):
        await update.effective_message.reply_text(TEXT_BAD_TOKEN)
        return
    replaced = result.get("replaced_tg_id")
    if replaced and str(replaced) != str(user.id):
        # к аккаунту был подключён другой Telegram — сообщаем ему
        try:
            await context.bot.send_message(int(replaced), "Аккаунт подключён к другому Telegram. "
                                           + TEXT_NOT_LINKED)
        except (TelegramError, ValueError) as err:
            log.info("не удалось уведомить прежний Telegram: %s", err)
    name = result.get("name") or ""
    greeting = f"Теперь вы вошли как {name}." if result.get("switched_from") else f"Готово, вы вошли как {name}."
    await send_list(update, context, greeting)


async def cmd_boards(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await send_list(update, context)


async def cmd_logout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        await api(context).unlink(update.effective_user.id)
    except AppUnavailable as err:
        log.warning("приложение недоступно: %s", err)
        await update.effective_message.reply_text(TEXT_UNAVAILABLE)
        return
    await update.effective_message.reply_text(
        "Telegram отключён от аккаунта. Чтобы подключиться снова, нажмите кнопку "
        "«Telegram» на стартовой странице приложения.")


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(TEXT_HELP)


async def other_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text("Я только показываю доски. /boards — список досок, /help — подсказка.")


async def edit(query, text: str, keyboard=None, html_mode: bool = True) -> bool:
    """Правит сообщение с кнопками. False — текст не изменился."""
    try:
        await query.edit_message_text(text, parse_mode=ParseMode.HTML if html_mode else None,
                                      reply_markup=keyboard, disable_web_page_preview=True)
        return True
    except BadRequest as err:
        if "message is not modified" in str(err).lower():
            return False
        raise


async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    data = query.data or ""
    user_id = update.effective_user.id
    try:
        if data == "l":
            result = await api(context).boards(user_id)
            if result.get("error") == "not_linked":
                await edit(query, esc(TEXT_NOT_LINKED))
                await query.answer()
                return
            text, keyboard = list_message(result)
            changed = await edit(query, text, keyboard)
            await query.answer(None if changed else "Без изменений")
            return

        parts = data.split(":")
        if len(parts) != 5 or parts[0] not in ("v", "p", "r"):
            await query.answer()
            return
        action, board_key, owner, page, revision = parts
        page = int(page) if page.isdigit() else 0
        board = await api(context).board(user_id, board_key, owner, view=(action == "v"))
    except AppUnavailable as err:
        log.warning("приложение недоступно: %s", err)
        await query.answer(TEXT_UNAVAILABLE, show_alert=True)
        return

    if board.get("error") == "not_linked":
        await edit(query, esc(TEXT_NOT_LINKED))
        await query.answer()
        return
    if board.get("error"):
        await edit(query, "Доска удалена.", back_to_list())
        await query.answer()
        return
    if action == "r" and revision == str(board.get("revision") or 0):
        await query.answer("Без изменений")
        return
    text, keyboard, _ = board_message(board, board_key, owner, page)
    changed = await edit(query, text, keyboard)
    await query.answer(None if changed or action != "r" else "Без изменений")


async def leave_group(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Группы не поддерживаются — бот выходит из них."""
    chat = update.effective_chat
    member = update.my_chat_member
    if member and member.new_chat_member.status in ("left", "kicked"):
        return  # бота уже убрали из группы
    if chat and chat.type != ChatType.PRIVATE:
        try:
            await context.bot.leave_chat(chat.id)
        except TelegramError as err:
            log.info("не удалось выйти из группы %s: %s", chat.id, err)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.error("ошибка обработки обновления", exc_info=context.error)
    if isinstance(context.error, Forbidden):
        return  # пользователь заблокировал бота


async def post_init(application: Application) -> None:
    await application.bot.set_my_commands([
        BotCommand("boards", "Список досок"),
        BotCommand("logout", "Отключить Telegram от аккаунта"),
        BotCommand("help", "Подсказка"),
    ])


async def post_shutdown(application: Application) -> None:
    await application.bot_data["api"].client.aclose()


def main() -> None:
    logging.basicConfig(format="%(asctime)s [%(name)s] %(levelname)s %(message)s", level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if not BOT_TOKEN or not BOT_SECRET:
        print("[bot] задайте TELEGRAM_BOT_TOKEN и KANBAN_BOT_SECRET (см. README.md, раздел «Telegram-бот»)")
        sys.exit(1)

    application = (Application.builder().token(BOT_TOKEN)
                   .post_init(post_init).post_shutdown(post_shutdown).build())
    application.bot_data["api"] = KanbanApi(KANBAN_URL, BOT_SECRET)

    private = filters.ChatType.PRIVATE
    application.add_handler(CommandHandler("start", cmd_start, filters=private))
    application.add_handler(CommandHandler("boards", cmd_boards, filters=private))
    application.add_handler(CommandHandler("logout", cmd_logout, filters=private))
    application.add_handler(CommandHandler("help", cmd_help, filters=private))
    application.add_handler(CallbackQueryHandler(on_button))
    application.add_handler(MessageHandler(filters.ChatType.GROUPS, leave_group))
    application.add_handler(ChatMemberHandler(leave_group, ChatMemberHandler.MY_CHAT_MEMBER))
    # остальной текст и неизвестные команды — подсказка
    application.add_handler(MessageHandler(private, other_text))
    application.add_error_handler(on_error)

    print(f"[bot] запущен, приложение: {KANBAN_URL}")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
