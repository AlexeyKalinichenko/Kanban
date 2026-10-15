"""
Общие доски: владелец открывает доступ к своей доске другим пользователям.

Права одни: получатель видит и редактирует доску (столбцы, карточки,
название, фон, теги), но не удаляет её и не управляет доступом — это может
только владелец. Получатель может убрать доску у себя из списка.

Доска по-прежнему лежит в папке владельца (Data/users/<владелец>/<доска>.txt);
id доски уникален только внутри пространства, поэтому общая доска
определяется парой «владелец + доска».

Хранение — Data/shares.txt, одна строка — один доступ:

  SHARE owner=<id владельца> board=<id доски> user=<id получателя> at=2026-10-15T22:30:00

Ссылка-приглашение на доску (одна на доску; кто откроет её со своим
аккаунтом, получает доступ):

  LINK owner=<id владельца> board=<id доски> token=<секрет из ссылки> at=2026-10-15T22:30:00

Владелец может сбросить ссылку (выдаётся новый секрет, старая ссылка
перестаёт работать) или выключить её. Доступ, который уже получили по
ссылке, при этом остаётся — закрыть его можно каждому по отдельности.

Строки с «#» и пустые — комментарии. Логины в файл не пишутся (логин можно
один раз сменить) — только id аккаунтов.
"""

import os
import re
import secrets
import threading
import uuid
from datetime import datetime

UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
LINE_RE = re.compile(rf"^SHARE\s+owner=({UUID})\s+board=({UUID})\s+user=({UUID})(?:\s+at=(\S+))?$")
LINK_RE = re.compile(rf"^LINK\s+owner=({UUID})\s+board=({UUID})\s+token=([A-Za-z0-9_-]{{16,64}})(?:\s+at=(\S+))?$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def new_token() -> str:
    """Секрет ссылки-приглашения: 128 случайных бит (22 символа)."""
    return secrets.token_urlsafe(16)


class ShareStore:
    """Список доступов в памяти + файл. Все операции — под одной блокировкой,
    файл перезаписывается целиком через временный файл."""

    def __init__(self, data_dir: str):
        self.path = os.path.join(data_dir, "shares.txt")
        self._lock = threading.RLock()
        self._items = None   # [{"owner", "board", "user", "at"}]
        self._links = None   # [{"owner", "board", "token", "at"}]
        self._mtime = None

    # ------------------------------------------------------------------
    # Чтение / запись
    # ------------------------------------------------------------------

    def _file_mtime(self):
        try:
            return os.stat(self.path).st_mtime_ns
        except OSError:
            return None

    def _ensure_loaded(self) -> None:
        # файл могли поправить руками — перечитываем, если он изменился
        mtime = self._file_mtime()
        if self._items is not None and mtime == self._mtime:
            return
        items = []
        links = []
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError:
            lines = []
        seen = set()
        link_boards = set()
        for raw in lines:
            m = LINK_RE.match(raw.strip())
            if m and (m.group(1), m.group(2)) not in link_boards:
                link_boards.add((m.group(1), m.group(2)))
                links.append({"owner": m.group(1), "board": m.group(2),
                              "token": m.group(3), "at": m.group(4) or ""})
                continue
            m = LINE_RE.match(raw.strip())
            if not m:
                continue
            owner, board, user, at = m.group(1), m.group(2), m.group(3), m.group(4) or ""
            key = (owner, board, user)
            if owner == user or key in seen:
                continue
            seen.add(key)
            items.append({"owner": owner, "board": board, "user": user, "at": at})
        self._items = items
        self._links = links
        self._mtime = mtime

    def _save(self) -> None:
        lines = [
            "# Общие доски: владелец (owner) открыл доступ к доске (board) пользователю (user)",
            "# Формат: SHARE owner=<id владельца> board=<id доски> user=<id получателя> at=<когда>",
            "#         LINK owner=<id владельца> board=<id доски> token=<секрет ссылки> at=<когда>",
            "",
        ]
        for s in self._items:
            lines.append(f"SHARE owner={s['owner']} board={s['board']} user={s['user']} at={s['at']}")
        if self._links:
            lines.append("")
        for l in self._links:
            lines.append(f"LINK owner={l['owner']} board={l['board']} token={l['token']} at={l['at']}")
        tmp = f"{self.path}.{uuid.uuid4().hex}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, self.path)
        self._mtime = self._file_mtime()

    # ------------------------------------------------------------------
    # Запросы
    # ------------------------------------------------------------------

    def has(self, owner: str, board: str, user: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            return any(s["owner"] == owner and s["board"] == board and s["user"] == user
                       for s in self._items)

    def users_for(self, owner: str, board: str) -> list:
        """Кому открыта доска: [{"user", "at"}] в порядке добавления."""
        with self._lock:
            self._ensure_loaded()
            return [{"user": s["user"], "at": s["at"]} for s in self._items
                    if s["owner"] == owner and s["board"] == board]

    def boards_for(self, user: str) -> list:
        """Доски, открытые пользователю: [{"owner", "board", "at"}] в порядке добавления."""
        with self._lock:
            self._ensure_loaded()
            return [{"owner": s["owner"], "board": s["board"], "at": s["at"]}
                    for s in self._items if s["user"] == user]

    def counts_for_owner(self, owner: str) -> dict:
        """Скольким пользователям открыта каждая доска владельца: {id доски: число}."""
        with self._lock:
            self._ensure_loaded()
            counts = {}
            for s in self._items:
                if s["owner"] == owner:
                    counts[s["board"]] = counts.get(s["board"], 0) + 1
            return counts

    def involves(self, user: str) -> bool:
        """Есть ли у пользователя общие доски (свои, открытые другим, или чужие)."""
        with self._lock:
            self._ensure_loaded()
            return any(s["owner"] == user or s["user"] == user for s in self._items)

    # ------------------------------------------------------------------
    # Изменения
    # ------------------------------------------------------------------

    def add(self, owner: str, board: str, user: str) -> bool:
        """Открыть доступ. False — доступ уже был."""
        if owner == user:
            return False
        with self._lock:
            self._ensure_loaded()
            if self.has(owner, board, user):
                return False
            self._items.append({"owner": owner, "board": board, "user": user,
                                "at": datetime.now().isoformat(timespec="seconds")})
            self._save()
            return True

    def _remove_where(self, match) -> list:
        with self._lock:
            self._ensure_loaded()
            removed = [s for s in self._items if match(s)]
            if removed:
                self._items = [s for s in self._items if not match(s)]
                self._save()
            return removed

    def remove(self, owner: str, board: str, user: str) -> bool:
        """Закрыть доступ одному пользователю. False — доступа и не было."""
        return bool(self._remove_where(
            lambda s: s["owner"] == owner and s["board"] == board and s["user"] == user))

    def remove_board(self, owner: str, board: str) -> list:
        """Доску удалили — закрываем доступ всем и выключаем ссылку.
        Возвращает удалённые записи доступа."""
        self.disable_link(owner, board)
        return self._remove_where(lambda s: s["owner"] == owner and s["board"] == board)

    def remove_user(self, user: str) -> list:
        """Аккаунт удалён — убираем его доступы (и как владельца, и как
        получателя) и его ссылки."""
        with self._lock:
            self._ensure_loaded()
            if any(l["owner"] == user for l in self._links):
                self._links = [l for l in self._links if l["owner"] != user]
                self._save()
        return self._remove_where(lambda s: s["owner"] == user or s["user"] == user)

    # ------------------------------------------------------------------
    # Ссылки-приглашения
    # ------------------------------------------------------------------

    def link_for(self, owner: str, board: str):
        """Секрет ссылки на доску или None (ссылки нет или она выключена)."""
        with self._lock:
            self._ensure_loaded()
            for l in self._links:
                if l["owner"] == owner and l["board"] == board:
                    return l["token"]
            return None

    def set_link(self, owner: str, board: str) -> str:
        """Создаёт ссылку на доску или выдаёт новую вместо старой (старая
        перестаёт работать). Возвращает секрет новой ссылки."""
        with self._lock:
            self._ensure_loaded()
            self._links = [l for l in self._links
                           if not (l["owner"] == owner and l["board"] == board)]
            token = new_token()
            self._links.append({"owner": owner, "board": board, "token": token,
                                "at": datetime.now().isoformat(timespec="seconds")})
            self._save()
            return token

    def disable_link(self, owner: str, board: str) -> bool:
        """Выключает ссылку на доску. False — ссылки и не было."""
        with self._lock:
            self._ensure_loaded()
            kept = [l for l in self._links if not (l["owner"] == owner and l["board"] == board)]
            if len(kept) == len(self._links):
                return False
            self._links = kept
            self._save()
            return True

    def find_link(self, token: str):
        """Доска по секрету ссылки: {"owner", "board"} или None."""
        if not TOKEN_RE.match(token or ""):
            return None
        with self._lock:
            self._ensure_loaded()
            for l in self._links:
                if secrets.compare_digest(l["token"], token):
                    return {"owner": l["owner"], "board": l["board"]}
            return None
