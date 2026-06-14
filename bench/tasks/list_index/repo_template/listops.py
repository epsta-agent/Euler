def get_item(items, index):
    # BUG: treats index 0 as falsy -> returns None instead of the first item.
    if not index:
        return None
    if index >= len(items):
        raise IndexError(index)
    return items[index]
