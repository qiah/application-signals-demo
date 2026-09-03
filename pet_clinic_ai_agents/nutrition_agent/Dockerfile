FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install -r requirements.txt

# Set environment variables
ENV DOCKER_CONTAINER=1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080

COPY . /app

# Start the application
# Omni guide gap workaround: the guide installs the ADOT distro but never says how it is activated on a
# container runtime. Without it, trace.get_tracer_provider() is the API ProxyTracerProvider and the
# guide's Strands wiring block crashes on add_span_processor. Launch under the ADOT auto-instrumentation
# entrypoint so ADOT owns the global TracerProvider, as the guide's own warning requires.
CMD ["opentelemetry-instrument", "python", "-m", "nutrition_agent"]
