"""
Статистика по журналу событий (Data/logs, см. events.py) для страницы /admin.

  compute(logs_dir, days, users) -> dict   — все цифры для дашборда за последние
                                             days дней (и сравнение с предыдущими days)

Считается прямо по файлам журнала (полный просмотр, индексов нет): при объёме
личного приложения это доли секунды; app.py дополнительно кэширует результат.

Можно запустить и из командной строки — краткая сводка в консоль:

  python3 stats.py [дней]
"""

import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from events import read_events

# Сколько неудачных входов с одного адреса за сутки — «заблокирован»
# (совпадает с LOGIN_FAIL_LIMIT в app.py) и с какого числа — «подозрительно»
FAILS_BLOCKED = 10
FAILS_SUSPICIOUS = 5
# С какого числа новых аккаунтов с одного адреса за сутки — «подозрительно»
CREATES_SUSPICIOUS = 10

COHORT_WEEKS = 8
RETENTION_DAYS = (1, 7, 30)
FEED_SIZE = 200

# Группы событий для фильтра ленты
EVENT_GROUPS = {
    "guest.start": "account", "guest.prompt": "account",
    "account.create": "account", "account.delete": "account",
    "session.start": "session", "session.end": "session",
    "visit.start": "visit", "visit.end": "visit",
    "login.fail": "login",
}

DURATION_BUCKETS = [(5, "до 5 минут"), (15, "5–15 минут"), (60, "15–60 минут"), (None, "больше часа")]

MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


def _date_label(d) -> str:
    return f"{d.day} {MONTHS[d.month - 1]}"


def _week_label(start, end) -> str:
    if start.month == end.month:
        return f"{start.day}–{end.day} {MONTHS[end.month - 1]}"
    return f"{_date_label(start)} – {_date_label(end)}"


def _parse_time(value: str):
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.astimezone()


def _int(value, default=0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _pct(part, whole):
    return round(part / whole * 100) if whole else None


def _median(values):
    if not values:
        return None
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def load(logs_dir: str) -> list:
    """Все события журнала с разобранным временем (поле "dt"), по порядку."""
    out = []
    for e in read_events(logs_dir):
        dt = _parse_time(e["time"])
        if dt:
            e["dt"] = dt
            out.append(e)
    out.sort(key=lambda e: e["dt"])
    return out


def _period_numbers(events: list, start, end) -> dict:
    """Счётчики одного периода [start, end)."""
    guests, prompted, created_gids = set(), set(), set()
    accounts = []
    active_by_day = defaultdict(set)
    active = set()
    for e in events:
        if not (start <= e["dt"] < end):
            continue
        ev = e["event"]
        if ev == "guest.start":
            guests.add(e.get("gid"))
        elif ev == "guest.prompt":
            prompted.add(e.get("gid"))
        elif ev == "account.create":
            accounts.append(e)
            created_gids.add(e.get("gid"))
        if ev in ("visit.start", "session.start") and e.get("uid"):
            active_by_day[e["dt"].date()].add(e["uid"])
            active.add(e["uid"])
    days = max(1, (end - start).days)
    dau = sum(len(v) for v in active_by_day.values()) / days
    return {"guests": len(guests), "prompted": len(prompted), "accounts": accounts,
            "dau": dau, "active": active}


def compute(logs_dir: str, days: int = 30, users=None, now=None) -> dict:
    """Цифры для дашборда за последние days дней. users — аккаунты из
    users.txt (для доли задавших пароль у тех, кто задал его до появления журнала)."""
    now = (now or datetime.now()).astimezone()
    events = load(logs_dir)
    today = now.date()
    start_day = today - timedelta(days=days - 1)
    tz = now.tzinfo

    def day_start(d):
        return datetime(d.year, d.month, d.day, tzinfo=tz)

    start = day_start(start_day)
    end = now + timedelta(seconds=1)
    prev_start = start - timedelta(days=days)

    cur = _period_numbers(events, start, end)
    prev = _period_numbers(events, prev_start, start)

    # --- по дням ---
    daily = {start_day + timedelta(days=i): {"guests": set(), "accounts": 0, "active": set()}
             for i in range(days)}
    for e in events:
        if e["dt"] < start:
            continue
        d = daily.get(e["dt"].date())
        if d is None:
            continue
        ev = e["event"]
        if ev == "guest.start":
            d["guests"].add(e.get("gid"))
        elif ev == "account.create":
            d["accounts"] += 1
        if ev in ("visit.start", "session.start") and e.get("uid"):
            d["active"].add(e["uid"])
    daily_rows = [{"date": day.isoformat(), "label": _date_label(day), "guests": len(v["guests"]),
                   "accounts": v["accounts"], "active": len(v["active"])}
                  for day, v in sorted(daily.items())]

    # --- WAU / MAU на сегодня ---
    def unique_active(since):
        return len({e["uid"] for e in events if e["dt"] >= since and e.get("uid")
                    and e["event"] in ("visit.start", "session.start")})
    wau = unique_active(day_start(today - timedelta(days=6)))
    mau = unique_active(day_start(today - timedelta(days=29)))

    # --- пароль ---
    password_at = {}
    for e in events:
        if e["event"] == "session.start" and e.get("reason") == "password" and e.get("uid"):
            password_at.setdefault(e["uid"], e["dt"])
    has_password = {u["id"] for u in (users or []) if u.get("password")}
    created = cur["accounts"]
    created_uids = [e.get("uid") for e in created]
    with_password = [u for u in created_uids if u in password_at or u in has_password]
    created_at = {e.get("uid"): e["dt"] for e in events if e["event"] == "account.create"}
    to_password = [(password_at[u] - created_at[u]).total_seconds() / 86400
                   for u in created_uids if u in password_at and u in created_at]

    # --- заходы ---
    durations = [_int(e.get("duration")) for e in events
                 if e["event"] == "visit.end" and start <= e["dt"] < end]
    bucket_counts = [0] * len(DURATION_BUCKETS)
    for m in durations:
        for i, (limit, _) in enumerate(DURATION_BUCKETS):
            if limit is None or m < limit:
                bucket_counts[i] += 1
                break
    duration_rows = [{"label": label, "count": c, "pct": _pct(c, len(durations))}
                     for (_, label), c in zip(DURATION_BUCKETS, bucket_counts)]
    prev_durations = [_int(e.get("duration")) for e in events
                      if e["event"] == "visit.end" and prev_start <= e["dt"] < start]

    hours = [0] * 24
    for e in events:
        if e["event"] == "visit.start" and start <= e["dt"] < end:
            hours[e["dt"].hour] += 1

    # --- удержание по неделям регистрации (не зависит от выбранного периода) ---
    activity = defaultdict(list)
    for e in events:
        if e["event"] in ("visit.start", "session.start") and e.get("uid"):
            activity[e["uid"]].append(e["dt"])
    this_monday = today - timedelta(days=today.weekday())
    cohorts = []
    for w in range(COHORT_WEEKS - 1, -1, -1):
        wk_start = this_monday - timedelta(weeks=w + 1)
        wk_end = wk_start + timedelta(days=6)
        lo, hi = day_start(wk_start), day_start(wk_end + timedelta(days=1))
        members = [e.get("uid") for e in events
                   if e["event"] == "account.create" and lo <= e["dt"] < hi and e.get("uid")]
        cells = []
        for n in RETENTION_DAYS:
            if day_start(wk_end + timedelta(days=n + 1)) > now:
                cells.append(None)       # срок ещё не прошёл для всей недели
                continue
            back = sum(1 for u in members
                       if any(t >= created_at[u] + timedelta(days=n) for t in activity.get(u, ())))
            cells.append(_pct(back, len(members)))
        if members or cohorts:
            cohorts.append({"week": _week_label(wk_start, wk_end), "accounts": len(members),
                            "retention": cells if members else [None] * len(RETENTION_DAYS)})

    # --- устройства ---
    last_ua = {}
    sids = defaultdict(set)
    for e in events:
        if not (start <= e["dt"] < end) or not e.get("uid"):
            continue
        if e["event"] in ("session.start", "account.create") and e.get("ua"):
            last_ua[e["uid"]] = e["ua"]
        if e.get("sid") and e["event"] in ("session.start", "visit.start"):
            sids[e["uid"]].add(e["sid"])
    browsers, systems = Counter(), Counter()
    for ua in last_ua.values():
        browser, _, system = ua.partition(" / ")
        browsers[browser.split(" ")[0] if system else "Другое"] += 1
        systems[system or "Другое"] += 1

    def shares(counter):
        total = sum(counter.values())
        rows = [{"label": k, "count": v, "pct": _pct(v, total)} for k, v in counter.most_common(5)]
        rest = total - sum(r["count"] for r in rows)
        if rest:
            rows.append({"label": "Другое", "count": rest, "pct": _pct(rest, total)})
        return rows

    period_events = [e for e in events if start <= e["dt"] < end]
    multi = sum(1 for s in sids.values() if len(s) >= 2)
    devices = {
        "browsers": shares(browsers), "systems": shares(systems),
        "multiDevicePct": _pct(multi, len(sids)), "multiDevice": multi,
        "logins": sum(1 for e in period_events if e["event"] == "session.start" and e.get("reason") == "login"),
        "logouts": sum(1 for e in period_events if e["event"] == "session.end" and e.get("reason") == "logout"),
        "passwordChanged": sum(1 for e in period_events
                               if e["event"] == "session.end" and e.get("reason") == "password_changed"),
    }

    # --- безопасность: последние 24 часа ---
    since = now - timedelta(hours=24)
    by_ip = defaultdict(lambda: {"fails": 0, "creates": 0, "names": [], "limited": False})
    for e in events:
        if e["dt"] < since or not e.get("ip"):
            continue
        row = by_ip[e["ip"]]
        if e["event"] == "login.fail":
            row["fails"] += 1
            if e.get("reason") == "rate_limited":
                row["limited"] = True
            name = e.get("name")
            if name and name not in row["names"]:
                row["names"].append(name)
        elif e["event"] == "account.create":
            row["creates"] += 1
    security = []
    for ip, row in by_ip.items():
        if row["fails"] == 0 and row["creates"] < 3:
            continue
        if row["limited"] or row["fails"] >= FAILS_BLOCKED:
            status = "blocked"
        elif row["fails"] >= FAILS_SUSPICIOUS or row["creates"] >= CREATES_SUSPICIOUS:
            status = "suspicious"
        else:
            status = "normal"
        security.append({"ip": ip, "fails": row["fails"], "creates": row["creates"],
                         "names": row["names"][:6], "status": status})
    order = {"blocked": 0, "suspicious": 1, "normal": 2}
    security.sort(key=lambda r: (order[r["status"]], -(r["fails"] + r["creates"])))
    security = security[:10]

    # --- лента (последние события; фильтр по группе — на странице) ---
    feed = []
    for e in reversed(events[-FEED_SIZE:]):
        details = " ".join(f"{k}={v}" for k, v in e.items() if k not in ("time", "event", "dt", "uid"))
        feed.append({"time": e["dt"].strftime("%d.%m %H:%M:%S"), "event": e["event"],
                     "group": EVENT_GROUPS.get(e["event"], "other"), "details": details})

    guests, accounts_n = cur["guests"], len(created)
    return {
        "days": days,
        "generatedAt": now.isoformat(timespec="seconds"),
        "since": events[0]["dt"].date().isoformat() if events else None,
        "empty": not events,
        # журнал покрывает весь прошлый период — иначе сравнение с ним бессмысленно
        "prevComplete": bool(events) and events[0]["dt"] <= prev_start,
        "kpis": {
            "accounts": accounts_n, "accountsPrev": len(prev["accounts"]),
            "dau": round(cur["dau"], 1), "dauPrev": round(prev["dau"], 1),
            "wau": wau, "mau": mau,
            "conversion": _pct(accounts_n, guests), "conversionPrev": _pct(len(prev["accounts"]), prev["guests"]),
            "passwordPct": _pct(len(with_password), accounts_n),
            "daysToPassword": round(_median(to_password), 1) if to_password else None,
            "visitAvg": round(sum(durations) / len(durations)) if durations else None,
            "visitAvgPrev": round(sum(prev_durations) / len(prev_durations)) if prev_durations else None,
            "visitMedian": _median(durations),
        },
        "daily": daily_rows,
        "funnel": {"guests": guests, "prompted": cur["prompted"], "accounts": accounts_n,
                   "password": len(with_password)},
        "durations": duration_rows,
        "hours": hours,
        "cohorts": cohorts,
        "devices": devices,
        "security": security,
        "feed": feed,
    }


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    data = compute(os.path.join(base, "Data", "logs"), n)
    k, f = data["kpis"], data["funnel"]
    print(f"Период: {n} дней (журнал с {data['since'] or '—'})")
    print(f"Новые аккаунты: {k['accounts']} (было {k['accountsPrev']})")
    print(f"Активных в день: {k['dau']}, WAU {k['wau']}, MAU {k['mau']}")
    print(f"Воронка: гости {f['guests']} → начали изменение {f['prompted']} → "
          f"аккаунт {f['accounts']} → пароль {f['password']}")
    print(f"Средний заход: {k['visitAvg']} мин, медиана {k['visitMedian']}")
    for r in data["security"]:
        print(f"  {r['ip']}: неудачных входов {r['fails']}, аккаунтов {r['creates']} — {r['status']}")
