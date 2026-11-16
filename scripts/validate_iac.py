"""Validación ESTÁTICA de la IaC de AWS sin desplegar (no requiere credenciales).

Ensambla una plantilla CloudFormation equivalente a la que generaría Serverless
(resolviendo ${param:...}/${self:...}/${sls:...}/${file(...)} con valores de
ejemplo y creando stubs de las Lambdas/HTTP API que Serverless genera) y la valida
con cfn-lint. También valida infra/aws/iam-roles.yml y la definición ASL.

Uso:  python scripts/validate_iac.py   (requiere: pip install cfn-lint)
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "backend"


class Tagged(dict):
    pass


def _ctor(tag):
    fn = {"!Ref": "Ref", "!Condition": "Condition"}.get(tag, "Fn::" + tag[1:])

    def construct(loader, node):
        if isinstance(node, yaml.ScalarNode):
            v = loader.construct_scalar(node)
            if tag == "!GetAtt":
                return {fn: v.split(".", 1)}
            return {fn: v}
        if isinstance(node, yaml.SequenceNode):
            return {fn: loader.construct_sequence(node, deep=True)}
        return {fn: loader.construct_mapping(node, deep=True)}

    return construct


class Loader(yaml.SafeLoader):
    pass


for t in ["!Ref", "!GetAtt", "!If", "!Equals", "!Not", "!Join", "!Sub", "!And", "!Or", "!Condition", "!Select", "!Split"]:
    Loader.add_constructor(t, _ctor(t))


def load_yaml(path: Path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=Loader)


VAR = re.compile(r"\$\{([^{}]+)\}")


def resolve(value, ctx):
    if isinstance(value, dict):
        return {k: resolve(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, ctx) for v in value]
    if not isinstance(value, str):
        return value
    m = VAR.fullmatch(value.strip())
    if m and m.group(1).startswith("file("):
        rel = m.group(1)[5:-1]
        p = (SERVICE_DIR / rel).resolve()
        data = json.loads(p.read_text(encoding="utf-8")) if p.suffix == ".json" else load_yaml(p)
        return resolve(data, ctx)

    def sub(mm):
        expr = mm.group(1)
        if expr.startswith("param:"):
            name = expr[6:].split(",")[0].strip()
            return str(ctx["params"].get(name, ""))
        if expr == "self:service":
            return ctx["service"]
        if expr == "sls:stage" or expr.startswith("opt:stage"):
            return "dev"
        if expr == "aws:region":
            return "us-east-1"
        if expr == "aws:accountId":
            return "123456789012"
        raise ValueError(f"Variable no soportada en validación: {expr}")

    out = VAR.sub(sub, value)
    if out in ("true", "false") and value.startswith("${param:"):
        return out == "true"
    return out


def logical_id(fn_name: str) -> str:
    return fn_name[0].upper() + fn_name[1:] + "LambdaFunction"


def main() -> int:
    sls = load_yaml(SERVICE_DIR / "serverless.yml")
    params = dict(sls["params"]["default"])
    params["labRoleArn"] = "arn:aws:iam::123456789012:role/LabRole"
    params["alertEmail"] = "alertas@example.com"
    params["notifyEmailSubscriber"] = "prueba@example.com"
    ctx = {"params": params, "service": sls["service"]}
    if not (SERVICE_DIR / "dist" / "statemachine-definition.json").exists():
        print("Falta backend/dist/statemachine-definition.json: ejecute primero npm run build -w backend")
        return 2
    res = resolve(sls["resources"], ctx)
    resources = dict(res["Resources"])
    role = params["labRoleArn"]
    for name, f in sls["functions"].items():
        resources[logical_id(name)] = {
            "Type": "AWS::Lambda::Function",
            "Properties": {
                "Runtime": sls["provider"]["runtime"],
                "Handler": f["handler"],
                "Role": role,
                "Code": {"S3Bucket": "bucket-de-ejemplo", "S3Key": "artefacto.zip"},
                "Timeout": f.get("timeout", sls["provider"]["timeout"]),
                "MemorySize": f.get("memorySize", sls["provider"]["memorySize"]),
                "Architectures": [resolve(sls["provider"]["architecture"], ctx)],
            },
        }
    resources["HttpApi"] = {"Type": "AWS::ApiGatewayV2::Api", "Properties": {"Name": "dev-telecorp-sentinel", "ProtocolType": "HTTP"}}
    stage_ext = res.get("extensions", {}).get("HttpApiStage", {}).get("Properties", {})
    resources["HttpApiStage"] = {"Type": "AWS::ApiGatewayV2::Stage", "Properties": {"ApiId": {"Ref": "HttpApi"}, "StageName": "$default", "AutoDeploy": True, **stage_ext}}
    template = {"AWSTemplateFormatVersion": "2010-09-09", "Conditions": res["Conditions"], "Resources": resources, "Outputs": res["Outputs"]}
    # La definición ASL embebida debe ser JSON válido una vez resuelta.
    parts = resources["IncidentWorkflow"]["Properties"]["DefinitionString"]["Fn::Join"][1]
    asl = "".join(p if isinstance(p, str) else "arn:aws:lambda:us-east-1:123456789012:function:x" for p in parts)
    json.loads(asl)
    tmp = Path(tempfile.gettempdir()) / "telecorp-sentinel-assembled.json"
    tmp.write_text(json.dumps(template, indent=1), encoding="utf-8")
    print(f"Plantilla ensamblada: {len(resources)} recursos -> {tmp}")
    rc = 0
    for f in [tmp, ROOT / "infra" / "aws" / "iam-roles.yml"]:
        r = subprocess.run([str(Path(sys.executable).with_name("cfn-lint")), "--format", "parseable", str(f)], capture_output=True, text=True)
        print(f"cfn-lint {f.name}: {'OK' if r.returncode == 0 else 'código ' + str(r.returncode)}")
        if r.stdout.strip():
            print(r.stdout.strip())
        # cfn-lint: 0 ok, 4 = sólo warnings, 2/6 = errores
        if r.returncode & 2:
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
