"""FlowLab Code Mode (PRD Part II): the user's code is the source of truth; the graph is a projection."""

from .blocks import Block, SourceFile, segment_file, segment_text
from .codegraph import CodeEdge, CodeGraph, CodeNode, GraphWarning, analyse_path, analyse_text, build_graph
from .patterns import PATTERNS, Pattern, match_calls
from .symbols import BlockSymbols, analyse_block

__all__ = [
    "PATTERNS",
    "Block",
    "BlockSymbols",
    "CodeEdge",
    "CodeGraph",
    "CodeNode",
    "GraphWarning",
    "Pattern",
    "SourceFile",
    "analyse_block",
    "analyse_path",
    "analyse_text",
    "build_graph",
    "match_calls",
    "segment_file",
    "segment_text",
]
