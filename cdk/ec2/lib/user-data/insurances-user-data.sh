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

# Retrieve database credentials from Secrets Manager
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/placement/region")
DB_SECRET=$(aws secretsmanager get-secret-value --secret-id PetClinicDBCredentials --region $REGION --query 'SecretString' --output text)
DB_USERNAME=$(echo "$DB_SECRET" | jq -r '.username')
DB_PASSWORD=$(echo "$DB_SECRET" | jq -r '.password')
echo "db username: $DB_USERNAME"
echo "db password: $DB_PASSWORD"

service_name="insurance-service-ec2-python"

# Start the application in a tmux session
tmux start-server
sleep 10
tmux new-session -s insurance -d
tmux send-keys -t insurance "cd /home/ec2-user/application-signals-demo/pet_clinic_insurance_service" C-m
tmux send-keys -t insurance "./ec2-setup.sh $DB_PASSWORD setup.demo.local $service_name" C-m
EOF