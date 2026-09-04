import json
import os
import random
import uuid
import urllib.parse as urlparse
from urllib.request import Request, urlopen
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

def load_prompts():
    with open('prompts.json', 'r') as f:
        return json.load(f)

def lambda_handler(event, context):
    """
    Traffic generator for the Pet Clinic agents.
    Prefers a DIRECT Bedrock AgentCore runtime invocation whenever PRIMARY_AGENT_ARN is set — that is the path
    that reliably produces agent spans/telemetry. Only when no agent ARN is available does it fall back to the
    EKS frontend route (POST /api/agent/ask), which requires the gateway to be configured with the agent ARN.
    """
    
    pet_clinic_url = os.environ.get('PET_CLINIC_URL', '')
    primary_agent_arn = os.environ.get('PRIMARY_AGENT_ARN')
    nutrition_agent_arn = os.environ.get('NUTRITION_AGENT_ARN')
    region = os.environ.get('AWS_REGION', 'us-east-1')
    session_id = os.environ.get('SESSION_ID', f"pet-clinic-session-{str(uuid.uuid4())}")
    
    if not pet_clinic_url and not primary_agent_arn:
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Neither PET_CLINIC_URL nor PRIMARY_AGENT_ARN set, skipping traffic generation'})
        }
    
    prompts = load_prompts()
    results = []
    
    # Generate queries for all requests
    queries = []
    for _ in range(random.randint(1, 4)):
        is_nutrition_query = random.random() <= 0.95
        queries.append(random.choice(prompts['nutrition-queries' if is_nutrition_query else 'non-nutrition-queries']))
    
    # Prefer direct runtime invocation when we have the agent ARN (reliably produces agent telemetry).
    if primary_agent_arn:
        session = boto3.Session()
        credentials = session.get_credentials()
        
        for query in queries:
            prompt = f"{query}\n\nNote: Our nutrition specialist agent ARN is {nutrition_agent_arn}" if nutrition_agent_arn else query

            try:
                encoded_arn = urlparse.quote(primary_agent_arn, safe='')
                url = f'https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{encoded_arn}/invocations?qualifier=DEFAULT'
                
                payload = json.dumps({'prompt': prompt}).encode('utf-8')
                request = AWSRequest(method='POST', url=url, data=payload, headers={
                    'Content-Type': 'application/json',
                    'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id
                })
                SigV4Auth(credentials, 'bedrock-agentcore', region).add_auth(request)
                
                with urlopen(Request(url, data=payload, headers=dict(request.headers))) as response:
                    body = response.read().decode('utf-8')
                
                results.append({
                    'query': query,
                    'response': body,
                    'agent_used': 'primary'
                })
                
            except Exception as error:
                results.append({
                    'query': query,
                    'error': str(error)
                })
    else:
        # Fallback: no agent ARN, drive the EKS frontend route instead.
        for query in queries:
            try:
                url = f"{pet_clinic_url.rstrip('/')}/api/agent/ask"
                payload = json.dumps({'query': query}).encode('utf-8')
                request = Request(url, data=payload, headers={'Content-Type': 'application/json'})
                
                with urlopen(request) as response:
                    body = response.read().decode('utf-8')
                
                results.append({
                    'query': query,
                    'response': body
                })
                
            except Exception as error:
                results.append({
                    'query': query,
                    'error': str(error)
                })
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'total_requests': len(results),
            'results': results
        })
    }