#Handles reading and writing to CSV files

import csv
from game import Game


class CSVStorage:
    #Loads games from a CSV file and returns a list of game objects
    def load_games(self, filename):
        games = []

        with open(filename, newline="", encoding="utf-8") as file:
            reader = csv.DictReader(file)

            for row in reader:
                if not row["title"]:
                    continue
                games.append(Game.from_dict(row))

        return games

    #Saves a list of game objects to a CSV file
    def save_games(self, filename, games):
        with open(filename, "w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=Game.csv_fields())
            writer.writeheader()

            for game in games:
                writer.writerow(game.to_dict())