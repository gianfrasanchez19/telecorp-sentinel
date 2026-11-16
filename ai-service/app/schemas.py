"""Contratos del microservicio de IA (entrada anonimizada y salida validada)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class IncidentContext(BaseModel):
    """Datos OPERATIVOS agregados. Nunca DNI, teléfono, correo, tokens ni ubicación exacta."""

    model_config = ConfigDict(extra="allow")

    kind: str = Field(max_length=40)
    status: str | None = Field(default=None, max_length=40)
    zoneCriticality: str | None = Field(default=None, max_length=40)
    zoneLabel: str | None = Field(default=None, max_length=80)
    family: str | None = Field(default=None, max_length=40)
    uniqueReporters: Any = None
    reportCount: Any = None
    estimatedUsersCatalog: int | None = None
    antennasConsidered: int | None = None
    worstAntennaStatus: str | None = None
    currentAntennaStatus: str | None = None
    recoveryDetected: bool | None = None
    investigationPending: bool | None = None
    priorityLevel: str | None = None


class AnalysisContext(BaseModel):
    contextVersion: str = Field(max_length=20)
    incident: IncidentContext
    problemTypes: dict[str, int] = Field(default_factory=dict)
    descriptions: list[str] = Field(default_factory=list, max_length=8)


class AnalyzeRequest(BaseModel):
    requestId: str = Field(min_length=1, max_length=120)
    context: AnalysisContext


class ModelOutput(BaseModel):
    """Lo que se le exige al modelo (JSON estricto)."""

    summary: str = Field(min_length=1, max_length=1500)
    probableCauses: list[str] = Field(max_length=8)
    recommendedActions: list[str] = Field(max_length=10)
    uncertainties: list[str] = Field(max_length=8)
    relatedProblemType: str = Field(max_length=60)


class AnalyzeResponse(ModelOutput):
    """Salida final: metadatos generados por el SERVIDOR, no por el modelo."""

    model: str
    generatedAt: str
    requestId: str
    latencyMs: int
