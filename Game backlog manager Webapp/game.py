class Game:
    #creates a game object from the CSV and stores the data for use throughout the project
    def __init__(self, title, genre, store, ownership, status,
                 rating, hours_played, completion_percentage,
                 priority, date_added, notes, steam_appid=""):
        self.title = title
        self.genre = genre
        self.store = store
        self.ownership = ownership
        self.status = status
        self.rating = rating
        self.hours_played = hours_played
        self.completion_percentage = completion_percentage
        self.priority = priority
        self.date_added = date_added
        self.notes = notes
        self.steam_appid = steam_appid

    #Default printout for selections and short lists
    def __str__(self):
        return f"{self.title} ({self.genre}) - {self.status}"

    #One line summary used for list display
    def summary(self):
        return (
            f"{self.title} | {self.genre} | {self.store} | {self.status} | "
            f"Rating: {self.rating}/10 | Hours: {self.hours_played} | "
            f"{self.completion_percentage}%"
        )

    #Full detail view for single game display
    def details(self):
        return (
            f"Title: {self.title}\n"
            f"Genre: {self.genre}\n"
            f"Store: {self.store}\n"
            f"Ownership: {self.ownership}\n"
            f"Status: {self.status}\n"
            f"Rating: {self.rating}/10\n"
            f"Hours Played: {self.hours_played}\n"
            f"Completion: {self.completion_percentage}%\n"
            f"Priority: {self.priority}\n"
            f"Date Added: {self.date_added}\n"
            f"Notes: {self.notes if self.notes else 'None'}"
        )

    #Converts a game object into a dictionary for CSV writing
    def to_dict(self):
        return {
            "title": self.title,
            "genre": self.genre,
            "store": self.store,
            "ownership": self.ownership,
            "status": self.status,
            "rating": self.rating,
            "hours_played": self.hours_played,
            "completion_percentage": self.completion_percentage,
            "priority": self.priority,
            "date_added": self.date_added,
            "notes": self.notes,
            "steam_appid": self.steam_appid,
        }

    #Creates a game object from a dictionary loaded from CSV
    @classmethod
    def from_dict(cls, data):
        return cls(
            data["title"],
            data["genre"],
            data["store"],
            data["ownership"],
            data["status"],
            int(data["rating"]),
            float(data["hours_played"]),
            int(data["completion_percentage"]),
            data["priority"],
            data["date_added"],
            data["notes"],
            data.get("steam_appid", ""),
        )

    #Returns the CSV column names used
    @staticmethod
    def csv_fields():
        return [
            "title",
            "genre",
            "store",
            "ownership",
            "status",
            "rating",
            "hours_played",
            "completion_percentage",
            "priority",
            "date_added",
            "notes",
            "steam_appid",
        ]
