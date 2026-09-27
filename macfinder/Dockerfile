FROM python:3.10-slim
WORKDIR /app
# ssh: /api/refresh-fleet reads oltmon.olt_meta through .186
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY onu_history_collect.py .
COPY templates ./templates
EXPOSE 5000
CMD ["python", "app.py"]
