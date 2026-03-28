from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    anthropic_api_key: str
    mongodb_url: str = "mongodb://mongo:27017"
    db_name: str = "chatapp"

    model_config = {"env_file": ".env"}


settings = Settings()
