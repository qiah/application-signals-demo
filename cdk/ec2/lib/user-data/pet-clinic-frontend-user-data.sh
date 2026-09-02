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
# --- Omni guide > EC2 > "Deploy the collector" > "EC2 user data / Launch Template" tab (verbatim) ---
curl -fsSL -o /tmp/amazon-cloudwatch-agent.rpm \
  https://amazoncloudwatch-agent.s3.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
rpm -Uvh /tmp/amazon-cloudwatch-agent.rpm
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

# Build the Frontend application
./mvnw clean install -pl spring-petclinic-api-gateway -am -DskipTests

# Function to wait for a URL to become accessible
wait_for_url() {
  local url=$1
  echo "Waiting for $url to be accessible..."
  until curl --silent --head --fail "$url"; do
    echo "$url is not accessible. Retrying in 10 seconds..."
    sleep 10
  done
  echo "$url is now accessible"
}

# Wait for config and discovery server to be ready
wait_for_url "http://setup.demo.local:8888"
wait_for_url "http://setup.demo.local:8761"


service_name="pet-clinic-frontend-ec2-java"

# Start the application in a tmux session
tmux start-server
sleep 10
tmux new-session -s frontend -d
tmux send-keys -t frontend "cd spring-petclinic-api-gateway/target/" C-m
tmux send-keys -t frontend "export CONFIG_SERVER_URL=http://setup.demo.local:8888" C-m
tmux send-keys -t frontend "export DISCOVERY_SERVER_URL=http://setup.demo.local:8761/eureka" C-m
tmux send-keys -t frontend "export SPRING_PROFILES_ACTIVE=ec2" C-m
# Omni guide > "Enable auto-instrumentation" (Java) — env + -javaagent, verbatim values
tmux send-keys -t frontend "export OTEL_SERVICE_NAME=$service_name" C-m
tmux send-keys -t frontend "export OTEL_RESOURCE_ATTRIBUTES=service.namespace=pet-clinic" C-m
tmux send-keys -t frontend "export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318" C-m
tmux send-keys -t frontend "export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf" C-m
tmux send-keys -t frontend "export OTEL_METRICS_EXPORTER=otlp" C-m
tmux send-keys -t frontend "export OTEL_LOGS_EXPORTER=otlp" C-m
tmux send-keys -t frontend "java -javaagent:/home/ec2-user/application-signals-demo/opentelemetry-javaagent.jar -jar spring-petclinic-api-gateway-*.jar" C-m

sleep 20
# start the traffic generator
cd /home/ec2-user/application-signals-demo/traffic-generator
wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
nvm install 20
nvm use 20
npm install
tmux new-session -s traffic -d 
tmux send-keys -t traffic "cd /home/ec2-user/application-signals-demo/traffic-generator" C-m
tmux send-keys -t traffic "export URL=http://pet-clinic-frontend.demo.local:8080" C-m
tmux send-keys -t traffic "node index.js" C-m
EOF