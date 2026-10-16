"""
Слияние одновременных изменений доски (общие доски: правят несколько человек).

Браузер сохраняет доску целиком и присылает вместе с ней «базу» — версию
доски, от которой он начал правку. Если с тех пор доску сохранил кто-то
другой, сервер не перезаписывает чужое, а сливает три версии:

  base   — версия, от которой начал правку этот браузер;
  mine   — что прислал этот браузер (base + его изменения);
  theirs — что сейчас лежит в файле (base + изменения других).

Правила (у карточек и столбцов постоянные id — по ним и сопоставляем):

- Поле (название доски, фон, название столбца, текст, приоритет, теги
  карточки, название и цвет тега) берётся из mine, если этот браузер его
  менял, иначе — из theirs. Если одно и то же поле поменяли оба — побеждает
  тот, кто сохранил последним (mine).
- Удалённое хоть одной стороной — удалено (карточка, столбец, тег).
  Карточки удалённого столбца удаляются вместе с ним.
- Добавленное любой стороной — добавлено.
- Порядок берётся из theirs; то, что этот браузер добавил или переставил
  (перенёс в другой столбец или сдвинул внутри столбца), ставится туда, куда
  поставил он: сразу после того же соседа сверху, что и у него.

Функция чистая (без файлов и блокировок) — её вызывает app.py под
блокировкой файла доски.
"""


def _pick(base, mine, theirs):
    """Поле: изменённое этим браузером — его значение, иначе — из файла."""
    return mine if mine != base else theirs


def _predecessors(ids: list) -> dict:
    """id -> id соседа сверху (слева) или None для первого."""
    return {item: (ids[i - 1] if i else None) for i, item in enumerate(ids)}


def merge_order(base_ids: list, mine_ids: list, theirs_ids: list) -> list:
    """Порядок элементов (столбцов, тегов) после слияния."""
    base_set, mine_set, theirs_set = set(base_ids), set(mine_ids), set(theirs_ids)
    deleted = (base_set - mine_set) | (base_set - theirs_set)
    result = [i for i in theirs_ids if i not in deleted]
    base_pred, mine_pred = _predecessors(base_ids), _predecessors(mine_ids)
    for idx, item in enumerate(mine_ids):
        if item in deleted:
            continue
        added = item not in base_set
        moved = not added and base_pred.get(item) != mine_pred.get(item)
        if not (added or moved):
            continue
        if item in result:
            result.remove(item)
        p = idx - 1
        while p >= 0 and mine_ids[p] not in result:
            p -= 1
        result.insert(result.index(mine_ids[p]) + 1 if p >= 0 else 0, item)
    return result


def _merge_fields(base: dict, mine: dict, theirs: dict, fields: tuple) -> dict:
    """Объединяет поля одного элемента, который есть хотя бы у одной стороны."""
    if theirs is None:
        return {f: mine.get(f) for f in fields}       # новый у этого браузера
    if mine is None or base is None:
        return {f: theirs.get(f) for f in fields}     # новый у других
    return {f: _pick(base.get(f), mine.get(f), theirs.get(f)) for f in fields}


def _card_places(columns: list) -> dict:
    """id карточки -> (id столбца, id карточки сверху или None)."""
    places = {}
    for col in columns:
        ids = [c["id"] for c in col["cards"]]
        for card_id, pred in _predecessors(ids).items():
            places[card_id] = (col["id"], pred)
    return places


CARD_FIELDS = ("text", "priority", "tags")
TAG_FIELDS = ("label", "color")


def merge_boards(base: dict, mine: dict, theirs: dict) -> dict:
    """Слияние трёх версий доски. Возвращает новую доску (в формате parse_board);
    created и revision — из theirs (их задаёт сервер)."""
    result = {
        "title": _pick(base.get("title"), mine.get("title"), theirs.get("title")),
        "background": _pick(base.get("background"), mine.get("background"), theirs.get("background")),
        "created": theirs.get("created", ""),
        "revision": theirs.get("revision", 0),
    }

    # --- теги доски ---
    by_key = lambda defs: {t["key"]: t for t in defs}
    b_tags, m_tags, t_tags = by_key(base["tagDefs"]), by_key(mine["tagDefs"]), by_key(theirs["tagDefs"])
    tag_order = merge_order([t["key"] for t in base["tagDefs"]],
                            [t["key"] for t in mine["tagDefs"]],
                            [t["key"] for t in theirs["tagDefs"]])
    result["tagDefs"] = [
        dict(key=k, **_merge_fields(b_tags.get(k), m_tags.get(k), t_tags.get(k), TAG_FIELDS))
        for k in tag_order
    ]

    # --- столбцы: порядок и названия ---
    by_id = lambda cols: {c["id"]: c for c in cols}
    b_cols, m_cols, t_cols = by_id(base["columns"]), by_id(mine["columns"]), by_id(theirs["columns"])
    col_order = merge_order([c["id"] for c in base["columns"]],
                            [c["id"] for c in mine["columns"]],
                            [c["id"] for c in theirs["columns"]])

    # --- карточки ---
    b_cards = {c["id"]: c for col in base["columns"] for c in col["cards"]}
    m_cards = {c["id"]: c for col in mine["columns"] for c in col["cards"]}
    t_cards = {c["id"]: c for col in theirs["columns"] for c in col["cards"]}
    deleted = (set(b_cards) - set(m_cards)) | (set(b_cards) - set(t_cards))

    # раскладка — из файла (столбцы, которых там нет, — новые у этого браузера)
    layout = {cid: [] for cid in col_order}
    for col in theirs["columns"]:
        if col["id"] in layout:
            layout[col["id"]] = [c["id"] for c in col["cards"] if c["id"] not in deleted]

    def remove_everywhere(card_id):
        for ids in layout.values():
            if card_id in ids:
                ids.remove(card_id)

    # карточки, которые этот браузер добавил или переставил, — на его места
    base_places, mine_places = _card_places(base["columns"]), _card_places(mine["columns"])
    for col in mine["columns"]:
        mine_ids = [c["id"] for c in col["cards"]]
        for idx, card_id in enumerate(mine_ids):
            if card_id in deleted:
                continue
            added = card_id not in b_cards
            moved = not added and base_places.get(card_id) != mine_places.get(card_id)
            if not (added or moved):
                continue
            remove_everywhere(card_id)
            target = layout.get(col["id"])
            if target is None:
                continue  # столбец удалили другие — карточка уходит вместе с ним
            p = idx - 1
            while p >= 0 and mine_ids[p] not in target:
                p -= 1
            target.insert(target.index(mine_ids[p]) + 1 if p >= 0 else 0, card_id)

    columns = []
    for cid in col_order:
        title = _merge_fields(b_cols.get(cid), m_cols.get(cid), t_cols.get(cid), ("title",))["title"]
        cards = []
        for card_id in layout[cid]:
            fields = _merge_fields(b_cards.get(card_id), m_cards.get(card_id),
                                   t_cards.get(card_id), CARD_FIELDS)
            cards.append(dict(id=card_id, **fields))
        columns.append({"id": cid, "title": title, "cards": cards})
    result["columns"] = columns
    return result
