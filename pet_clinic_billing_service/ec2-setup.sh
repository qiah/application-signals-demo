#!/bin/bash
psql_pass=$1
private_setup_ip_address=$2
SVC_NAME=$3

sudo yum install python3-pip python3-devel postgresql15 libpq-devel gcc tmux -y

# get rds endpoint
rds_endpoint=`aws rds describe-db-instances --db-instance-identifier petclinic-python --query "DBInstances[*].Endpoint.Address"`
rds_endpoint=`echo $rds_endpoint | cut -d "\"" -f2 | cut -d "\"" -f1`

export DJANGO_SETTINGS_MODULE=pet_clinic_billing_service.settings
export DB_NAME=postgres
export DB_USER=djangouser
export DB_USER_PASSWORD=$psql_pass
export DATABASE_PROFILE=postgresql
export DB_SERVICE_HOST=$rds_endpoint
export DB_SERVICE_PORT=5432
export EUREKA_SERVER_URL=$private_setup_ip_address

python3 -m pip install -r requirements.txt
# Omni guide > "Install the OpenTelemetry SDK" (Python) — verbatim
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
# Omni guide > "Add APM metrics (RED)" > Python > Django — verbatim
pip install cloudwatch-plugin-otel


python3 manage.py migrate  
# Omni guide > "Enable auto-instrumentation" (Python) — verbatim
OTEL_SERVICE_NAME=$SVC_NAME \
OTEL_RESOURCE_ATTRIBUTES=service.namespace=pet-clinic \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_METRICS_EXPORTER=otlp \
OTEL_LOGS_EXPORTER=otlp \
OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true \
opentelemetry-instrument python3 manage.py runserver 0.0.0.0:8800 --noreload