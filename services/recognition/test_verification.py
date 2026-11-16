"""Decision-rule tests use synthetic scores, never evidence of model accuracy."""
from verification import BACKGROUND, contains_food, decide_review


CATEGORIES = {"egg": "protein", "orange": "fruit", "apple": "fruit", "pear": "fruit", "sugar": "pantry", "salt": "pantry"}


def test_ambiguous_and_background_containers_are_not_food():
    assert decide_review("bowl", [("sugar", .31), ("salt", .30)], CATEGORIES) is None
    assert decide_review("paper bag", [(BACKGROUND, .4), ("sugar", .3)], CATEGORIES) is None
    assert decide_review("bowl", [("sugar", .34), ("salt", .29)], CATEGORIES) == "sugar"


def test_only_strong_cross_category_disagreements_suggest_a_new_name():
    assert decide_review("orange", [("egg", .32), ("apple", .27), ("orange", .22)], CATEGORIES) == "egg"
    assert decide_review("orange", [("egg", .32), ("orange", .29)], CATEGORIES) is None
    assert decide_review("apple", [("pear", .4), ("apple", .2)], CATEGORIES) is None


def test_container_of_detected_food_does_not_add_a_duplicate():
    bowl = {"name": "bowl", "box": [0, 0, 100, 100]}
    egg = {"name": "egg", "box": [10, 10, 30, 30]}
    assert contains_food(bowl, [bowl, egg])
    assert not contains_food(bowl, [bowl])
    assert not contains_food(bowl, [{"name": "egg", "box": [90, 90, 110, 110]}])
