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

dotnet build --runtime linux-x64

dotnet bin/Debug/net8.0/linux-x64/PetClinic.PaymentService.dll -v n