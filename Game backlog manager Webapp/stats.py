class StatisticsManager:
    #finds the games to use in stats
    def __init__(self, games):
        self.games = games


    #Returns the total number of games
    def total_games(self):
        return len(self.games)

    #Returns the number of completed games
    def completed_games_count(self):
        return sum(1 for game in self.games if game.status == "Completed")

    #Returns the number of in progress games
    def in_progress_games_count(self):
        return sum(1 for game in self.games if game.status == "In Progress")

    #Returns the number of wishlist games
    def wishlist_games_count(self):
        return sum(1 for game in self.games if game.ownership == "Wishlist")

    #Returns total hours played across all games
    def total_hours_played(self):
        return sum(game.hours_played for game in self.games)

    #Returns the average rating
    def average_rating(self):
        ratings = [game.rating for game in self.games if game.rating > 0]
        return sum(ratings) / len(ratings) if ratings else 0

    #Returns the average completion percentage
    def average_completion(self):
        completions = [game.completion_percentage for game in self.games]
        return sum(completions) / len(completions) if completions else 0