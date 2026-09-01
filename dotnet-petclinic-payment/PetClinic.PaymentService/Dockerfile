FROM mcr.microsoft.com/dotnet/sdk:8.0
WORKDIR /app

COPY . .

RUN dotnet restore
RUN dotnet build
RUN dotnet publish -c Release -o out

# OpenTelemetry .NET automatic instrumentation.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSfL https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh -o /tmp/otel-install.sh \
 && sh /tmp/otel-install.sh
ENV CORECLR_ENABLE_PROFILING=1 \
    CORECLR_PROFILER={918728DD-259F-4A6A-AC2B-B85E1B658318} \
    CORECLR_PROFILER_PATH=/root/.otel-dotnet-auto/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so \
    DOTNET_ADDITIONAL_DEPS=/root/.otel-dotnet-auto/AdditionalDeps \
    DOTNET_SHARED_STORE=/root/.otel-dotnet-auto/store \
    DOTNET_STARTUP_HOOKS=/root/.otel-dotnet-auto/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll

ENV ASPNETCORE_ENVIRONMENT=Development

EXPOSE 8080

ENTRYPOINT [ "dotnet", "./out/PetClinic.PaymentService.dll" ]