"""
Правки на общих досках — для уведомлений «Доску «…» изменил пользователь …».

Помним две вещи:
- кто и когда последний раз правил общую доску (по каждому участнику);
- когда каждый участник последний раз видел доску (была открыта у него на
  экране) и когда закрыл уведомление о ней.

Уведомление участнику — если после того, как он видел доску (или закрыл
уведомление), её правил кто-то другой. Пока доска открыта, участник видит
чужие правки сразу (автообновление), и уведомления о них не будет.

Хранение — Data/activity.txt (человекочитаемый текст, как и остальное):

  EDIT owner=<id владельца> board=<id доски> user=<кто правил> at=2026-10-22T07:40:00
  VIEW owner=<id владельца> board=<id доски> user=<участник> seen=2026-10-22T07:45:10 [notified=…]

Строки удаляются, когда они больше не нужны: доску удалили, участнику
закрыли доступ (или он убрал доску у себя), у доски не осталось ни одного
получателя (она больше не общая), аккаунт удалён чисткой.

Данные меняются часто (каждое сохранение доски, каждая проверка открытой
доски), поэтому они живут в памяти, а в файл пишутся не чаще раза в
FLUSH_SECONDS секунд и при остановке сервера. Если сервер выключить
аварийно, потеряются только последние секунды — в худшем случае придёт
лишнее уведомление или не придёт одно.
"""

import atexit
import os
import re
import threading
import uuid
from datetime import datetime

FLUSH_SECONDS = 10

UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
EDIT_RE = re.compile(rf"^EDIT\s+owner=({UUID})\s+board=({UUID})\s+user=({UUID})\s+at=(\S+)$")
VIEW_RE = re.compile(rf"^VIEW\s+owner=({UUID})\s+board=({UUID})\s+user=({UUID})\s+seen=(\S*)(?:\s+notified=(\S+))?$")


def now_iso() -> str:
    return datetime.now().isoformat(timespec="milliseconds")


class ActivityStore:
    def __init__(self, data_dir: str):
        self.path = os.path.join(data_dir, "activity.txt")
        self._lock = threading.RLock()
        self._edits = {}   # (owner, board) -> {user: время последней правки}
        self._views = {}   # (owner, board, user) -> {"seen": время, "notified": время}
        self._loaded = False
        self._timer = None
        atexit.register(self.flush)

    # ------------------------------------------------------------------
    # Файл
    # ------------------------------------------------------------------

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError:
            return
        for raw in lines:
            line = raw.strip()
            m = EDIT_RE.match(line)
            if m:
                self._edits.setdefault((m.group(1), m.group(2)), {})[m.group(3)] = m.group(4)
                continue
            m = VIEW_RE.match(line)
            if m:
                self._views[(m.group(1), m.group(2), m.group(3))] = {
                    "seen": m.group(4) or "", "notified": m.group(5) or ""}

    def _changed(self) -> None:
        """Записать файл позже (не чаще раза в FLUSH_SECONDS). Под self._lock."""
        if self._timer is None:
            self._timer = threading.Timer(FLUSH_SECONDS, self.flush)
            self._timer.daemon = True
            self._timer.start()

    def flush(self) -> None:
        with self._lock:
            self._timer = None
            if not self._loaded:
                return
            lines = [
                "# Правки на общих досках (для уведомлений «доску изменил …»)",
                "# EDIT — кто и когда последний раз правил доску;",
                "# VIEW — когда участник последний раз видел доску (seen) и закрыл уведомление (notified)",
                "",
            ]
            for (owner, board), editors in self._edits.items():
                for user, at in editors.items():
                    lines.append(f"EDIT owner={owner} board={board} user={user} at={at}")
            for (owner, board, user), v in self._views.items():
                line = f"VIEW owner={owner} board={board} user={user} seen={v.get('seen', '')}"
                if v.get("notified"):
                    line += f" notified={v['notified']}"
                lines.append(line)
            tmp = f"{self.path}.{uuid.uuid4().hex}.tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
                os.replace(tmp, self.path)
            except OSError as err:
                print("[activity] не удалось записать activity.txt:", err)

    # ------------------------------------------------------------------
    # Изменения
    # ------------------------------------------------------------------

    def record_edit(self, owner: str, board: str, user: str) -> None:
        """Участник сохранил доску (он её при этом, конечно, видит)."""
        with self._lock:
            self._ensure_loaded()
            now = now_iso()
            self._edits.setdefault((owner, board), {})[user] = now
            self._views.setdefault((owner, board, user), {"seen": "", "notified": ""})["seen"] = now
            self._changed()

    def touch_view(self, owner: str, board: str, user: str) -> None:
        """Доска открыта у участника на экране (открыл или проверка автообновления)."""
        with self._lock:
            self._ensure_loaded()
            view = self._views.setdefault((owner, board, user), {"seen": "", "notified": ""})
            view["seen"] = now_iso()
            self._changed()

    def mark_notified(self, user: str, boards: list) -> None:
        """Участник закрыл уведомление об этих досках: [(owner, board), …]."""
        with self._lock:
            self._ensure_loaded()
            now = now_iso()
            for owner, board in boards:
                view = self._views.setdefault((owner, board, user), {"seen": "", "notified": ""})
                view["notified"] = now
            self._changed()

    def remove_board(self, owner: str, board: str) -> None:
        with self._lock:
            self._ensure_loaded()
            self._edits.pop((owner, board), None)
            for key in [k for k in self._views if k[0] == owner and k[1] == board]:
                del self._views[key]
            self._changed()

    def remove_participant(self, owner: str, board: str, user: str) -> None:
        """Участнику закрыли доступ к доске (или он убрал её у себя): его
        строки по этой доске больше не нужны."""
        with self._lock:
            self._ensure_loaded()
            changed = self._views.pop((owner, board, user), None) is not None
            editors = self._edits.get((owner, board))
            if editors and editors.pop(user, None) is not None:
                changed = True
                if not editors:
                    del self._edits[(owner, board)]
            if changed:
                self._changed()

    def remove_user(self, user: str) -> None:
        """Аккаунт удалён: его доски и его отметки больше не нужны."""
        with self._lock:
            self._ensure_loaded()
            for key in [k for k in self._edits if k[0] == user]:
                del self._edits[key]
            for editors in self._edits.values():
                editors.pop(user, None)
            for key in [k for k in self._views if k[0] == user or k[2] == user]:
                del self._views[key]
            self._changed()

    # ------------------------------------------------------------------
    # Запросы
    # ------------------------------------------------------------------

    def changes_for(self, owner: str, board: str, user: str, since: str = "") -> list:
        """Кто, кроме user, правил доску после того, как user её видел (или
        закрыл уведомление, или после since). [(кто, когда)], сначала свежие."""
        with self._lock:
            self._ensure_loaded()
            view = self._views.get((owner, board, user), {})
            mark = max(view.get("seen", ""), view.get("notified", ""), since or "")
            editors = self._edits.get((owner, board), {})
            found = [(u, at) for u, at in editors.items() if u != user and at > mark]
            return sorted(found, key=lambda x: x[1], reverse=True)
