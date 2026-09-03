#!/bin/bash
private_setup_ip_address=$1
service_name=$2

sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc
sudo wget -O /etc/yum.repos.d/microsoft-prod.repo https://packages.microsoft.com/config/fedora/37/prod.repo
sudo dnf install -y dotnet-sdk-8.0
dotnet --version > /tmp/dotnet-version

export eureka__client__serviceUrl=http://${private_setup_ip_address}:8761/eureka/
export eureka__instance__port=8080
export ASPNETCORE_URLS="http://+:8080"
export ASPNETCORE_ENVIRONMENT=Development

# Omni guide > "Enable auto-instrumentation" (.NET) — verbatim
curl -sSfL https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh -o install.sh && sh install.sh
export OTEL_SERVICE_NAME=$service_name
export OTEL_RESOURCE_ATTRIBUTES=service.namespace=pet-clinic
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
dotnet build --runtime linux-x64
# Deviation from the guide: source instrument.sh only for the run. Sourced before `dotnet build`, the startup hook
# loads into the build tooling and restore fails on .NET 8 (DiagnosticSource 10.0.0.0 not found).
. $HOME/.otel-dotnet-auto/instrument.sh

dotnet bin/Debug/net8.0/linux-x64/PetClinic.PaymentService.dll -v n