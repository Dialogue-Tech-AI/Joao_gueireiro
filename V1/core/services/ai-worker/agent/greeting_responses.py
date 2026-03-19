"""
Fixed greeting responses for SAUDACAO intent (0 tokens cost)
"""
from typing import Tuple


def get_greeting_response() -> Tuple[str, list[str]]:
    """
    Returns a fixed greeting response and its fragments
    
    Returns:
        Tuple of (full_response, fragments_list)
    """
    response = "Olá, seja bem-vindo! Sou o assistente virtual. Você está procurando por alguma peça ou deseja outra informação?"
    
    fragments = [
        "Olá, seja bem-vindo!",
        "Sou o assistente virtual.",
        "Você está procurando por alguma peça ou deseja outra informação?"
    ]
    
    return response, fragments
