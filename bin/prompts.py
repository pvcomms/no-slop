"""Genre × topic prompts shared by the generators (gen-ollama.py, gen-claude.py).
Plain requests with no style instructions: the point is each model's default voice."""

GENRES = [
    "LinkedIn post", "blog post introduction", "product description", "short email to a colleague",
    "restaurant review", "book review", "Reddit comment", "tweet", "short X thread", "cover letter paragraph",
    "travel guide paragraph", "news summary", "customer support reply", "podcast episode description",
    "app store description", "motivational post", "answer to a forum question", "short essay paragraph",
    "company announcement", "event recap", "YouTube video description", "newsletter opening",
    "personal reflection", "how-to guide introduction", "movie synopsis", "Substack note",
]
TOPICS = [
    "remote work", "learning to code", "a new coffee shop", "sleep and productivity", "electric cars",
    "a hiking trip in Norway", "leadership lessons", "a sci-fi novel", "home gardening", "personal finance",
    "a startup that sells AI tools", "running a first marathon", "minimalism", "a jazz concert",
    "burnout", "public transport in Berlin", "a new smartphone", "climate policy", "meditation",
    "hiring engineers", "a failed product launch", "cooking pasta", "moving to a new city",
    "social media and attention", "a museum exhibit", "learning German", "chess", "a data breach",
    "the future of education", "a local bakery", "a board game night", "time management",
    "a documentary about oceans", "freelancing", "an art gallery opening", "mental health at work",
    "a software update", "a music festival", "networking events", "a used bookstore",
]
LENGTHS = ["", " Keep it under 120 words.", " About 150 words.", " Two short paragraphs."]
