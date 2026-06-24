import random


class Recommender:
    def recommend(self, games):
        raise NotImplementedError("Subclasses must implement recommend().")


#Recommends games using a scoring system which is weighted heavily to favour games that have a high rating, with additional points for game priority and finally taking into account game completion percentage
class TopThreeBacklogRecommender(Recommender):

    def score(self, game):
        score = game.rating * 2

        if game.priority == "High":
            score += 10
        elif game.priority == "Medium":
            score += 5

        score -= game.completion_percentage
        return score

    def recommend(self, games):
        candidates = [
            game for game in games
            if game.ownership == "Owned" and game.status != "Completed"
        ]

        ranked = sorted(candidates, key=self.score, reverse=True)
        return ranked[:3]

class TopThreeWishlistRecommender(Recommender):

    def score(self, game):
        score = game.rating * 2

        if game.priority == "High":
            score += 10
        elif game.priority == "Medium":
            score += 5

        return score

    def recommend(self, games):
        candidates = [game for game in games if game.ownership == "Wishlist"]

        ranked = sorted(candidates, key=self.score, reverse=True)
        return ranked[:3]


#Returns one random unfinished backlog game at random
class RandomBacklogRecommender(Recommender):

    def recommend(self, games):
        candidates = [
            game for game in games
            if game.ownership == "Owned" and game.status != "Completed"
        ]

        if not candidates:
            return None

        return random.choice(candidates)