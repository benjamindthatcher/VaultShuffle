import re


class GameBacklog:
    # starts an empty backlog
    def __init__(self):
        self.games = []

    #Adds a game to the backlog
    def add_game(self, game):
        self.games.append(game)

    #Removes a game and returns it
    def remove_game(self, index):
        return self.games.pop(index)

    #Returns all games in the backlog
    def get_all_games(self):
        return self.games

    #Returns a specific game
    def get_game(self, index):
        return self.games[index]

    #Returns the number of games in the backlog
    def count(self):
        return len(self.games)

    #checks if the backlog is empty
    def is_empty(self):
        return len(self.games) == 0

    #Returns completed games
    def completed_games(self):
        return [game for game in self.games if game.status == "Completed"]

    #Returns in progress games
    def in_progress_games(self):
        return [game for game in self.games if game.status == "In Progress"]

    #Returns wishlist games
    def wishlist_games(self):
        return [game for game in self.games if game.ownership == "Wishlist"]


    #Searches a field using regex and finds matching games
    def search_by_field_regex(self, field_name, pattern):
        matches = []

        for game in self.games:
            value = str(getattr(game, field_name))
            if re.search(pattern, value, re.IGNORECASE):
                matches.append(game)

        return matches