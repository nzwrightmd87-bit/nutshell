FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY deployment/e2ee_chat/requirements-chat-api.txt /app/requirements-chat-api.txt
RUN pip install --no-cache-dir -r /app/requirements-chat-api.txt

COPY execution /app/execution
COPY web /app/web

EXPOSE 8787

CMD ["uvicorn", "execution.e2ee_chat_server:app", "--host", "0.0.0.0", "--port", "8787"]
