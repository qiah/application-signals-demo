#!/usr/bin/env bash

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
sudo -iu ec2-user bash <<'EOF'
set -x
# Set home directory
cd ~

# Clone the application repository
git clone -b omni-demo https://github.com/qiah/application-signals-demo.git
cd application-signals-demo/

# Build the vets application
./mvnw clean install -pl spring-petclinic-vets-service -am -DskipTests

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


service_name="vets-service-ec2-java"

# Start the application in a tmux session
tmux start-server
sleep 10
tmux new-session -s vets -d
tmux send-keys -t vets "cd spring-petclinic-vets-service/target/" C-m
tmux send-keys -t vets "export CONFIG_SERVER_URL=http://setup.demo.local:8888" C-m
tmux send-keys -t vets "export DISCOVERY_SERVER_URL=http://setup.demo.local:8761/eureka" C-m
tmux send-keys -t vets "export SPRING_PROFILES_ACTIVE=ec2" C-m
tmux send-keys -t vets "java -jar spring-petclinic-vet*.jar" C-m
EOF