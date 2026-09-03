#!/usr/bin/env bash
set -x

# Install necessary packages
# retry due to the error like this: "RPM: error: can't create transaction lock on /var/lib/rpm/.rpm.lock (Resource temporarily unavailable)"
# sometime the ec2 instances are launched too fast that when the script runs something is not really ready
# see https://repost.aws/questions/QU_tj7NQl6ReKoG53zzEqYOw/amazon-linux-2023-issue-with-installing-packages-with-cloud-init
max_attempts=5
attempt_num=1
success=false
while [ $success = false ] && [ $attempt_num -le $max_attempts ]; do
  echo "Trying yum install"
  yum update -y
  yum install -y java-17-amazon-corretto-devel git tmux wget jq
  # Check the exit code of the command
  if [ $? -eq 0 ]; then
    echo "Yum install succeeded"
    success=true
  else
    echo "Attempt $attempt_num failed. Sleeping for 3 seconds and trying again..."
    sleep 3
    ((attempt_num++))
  fi
done


# Switch to ec2-user to run commands
# --- Omni guide > EC2 > "Deploy the collector" > "EC2 user data / Launch Template" tab ---
# Deviation: the guide's bare `rpm -Uvh` races the boot-time RPM lock (3/8 hosts came up with no agent) and is
# not idempotent; `dnf install` waits for the lock and is safe to re-run.
curl -fsSL -o /tmp/amazon-cloudwatch-agent.rpm \
  https://amazoncloudwatch-agent.s3.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
dnf install -y /tmp/amazon-cloudwatch-agent.rpm
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -c default:otel -s

sudo -iu ec2-user bash <<'EOF'
set -x
# Set home directory
cd ~

# Clone the application repository
git clone -b omni-demo https://github.com/qiah/application-signals-demo.git
cd application-signals-demo/
# Omni guide > "Install the OpenTelemetry SDK" (Java) — verbatim
curl -L -o opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

# Build the Config Server and Discovery Server
./mvnw clean install -DskipTests

# Start the Config Server in a tmux session
tmux start-server
sleep 10
tmux new-session -d -s config-server
tmux send-keys -t config-server 'cd spring-petclinic-config-server/target/' C-m
# Omni guide > "Enable auto-instrumentation" (Java) — env + -javaagent, verbatim values
tmux send-keys -t config-server "export OTEL_SERVICE_NAME=config-server-ec2-java" C-m
tmux send-keys -t config-server "export OTEL_RESOURCE_ATTRIBUTES=service.namespace=pet-clinic" C-m
tmux send-keys -t config-server "export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318" C-m
tmux send-keys -t config-server "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf" C-m
tmux send-keys -t config-server "export OTEL_METRICS_EXPORTER=otlp" C-m
tmux send-keys -t config-server "export OTEL_LOGS_EXPORTER=otlp" C-m
tmux send-keys -t config-server "java -javaagent:/home/ec2-user/application-signals-demo/opentelemetry-javaagent.jar -jar spring-petclinic-config-server-*.jar" C-m

# Wait for Config Server to start
sleep 20

# Start the Discovery Server in a tmux session
tmux new-session -d -s discovery-server
tmux send-keys -t discovery-server 'cd spring-petclinic-discovery-server/target/' C-m
# Omni guide > "Enable auto-instrumentation" (Java) — env + -javaagent, verbatim values
tmux send-keys -t discovery-server "export OTEL_SERVICE_NAME=discovery-server-ec2-java" C-m
tmux send-keys -t discovery-server "export OTEL_RESOURCE_ATTRIBUTES=service.namespace=pet-clinic" C-m
tmux send-keys -t discovery-server "export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318" C-m
tmux send-keys -t discovery-server "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf" C-m
tmux send-keys -t discovery-server "export OTEL_METRICS_EXPORTER=otlp" C-m
tmux send-keys -t discovery-server "export OTEL_LOGS_EXPORTER=otlp" C-m
tmux send-keys -t discovery-server "java -javaagent:/home/ec2-user/application-signals-demo/opentelemetry-javaagent.jar -jar spring-petclinic-discovery-server-*.jar" C-m

# Wait for Config Server to start
sleep 20

# Start the Admin Server in a tmux session
tmux new -s admin -d
tmux send-keys -t admin 'cd spring-petclinic-admin-server/target/' C-m
# Omni guide > "Enable auto-instrumentation" (Java) — env + -javaagent, verbatim values
tmux send-keys -t admin "export OTEL_SERVICE_NAME=admin-server-ec2-java" C-m
tmux send-keys -t admin "export OTEL_RESOURCE_ATTRIBUTES=service.namespace=pet-clinic" C-m
tmux send-keys -t admin "export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318" C-m
tmux send-keys -t admin "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf" C-m
tmux send-keys -t admin "export OTEL_METRICS_EXPORTER=otlp" C-m
tmux send-keys -t admin "export OTEL_LOGS_EXPORTER=otlp" C-m
tmux send-keys -t admin "java -javaagent:/home/ec2-user/application-signals-demo/opentelemetry-javaagent.jar -jar spring-petclinic-admin-server*.jar" C-m
EOF