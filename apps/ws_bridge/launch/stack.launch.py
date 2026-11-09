"""OPTIONAL ROS 2 stack: franka_ros2 MoveIt bringup + the ws_bridge.

Not part of the v1 deployment (see ws_bridge/node.py). Usage:
    ros2 launch ws_bridge stack.launch.py robot_ip:=172.16.0.2 use_fake_hardware:=true

franka_moveit_config/launch/moveit.launch.py (franka_ros2 0.1.x) starts the
ros2_control node with franka_hardware, the controllers, the gripper and
move_group. Do NOT also include franka_bringup/franka.launch.py: that would
start a second controller manager that connects to the same robot.

Check the declared arguments of your franka_ros2 release with
    ros2 launch franka_moveit_config moveit.launch.py --show-args
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import EnvironmentVariable, LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    moveit_launch = os.path.join(get_package_share_directory("franka_moveit_config"), "launch", "moveit.launch.py")
    return LaunchDescription(
        [
            DeclareLaunchArgument(
                "robot_ip",
                default_value=EnvironmentVariable("FRANKA_HOST", default_value="172.16.0.2"),
                description="IP of the Panda control unit (FCI)",
            ),
            # Simulation by default. Set use_fake_hardware:=false for the robot.
            DeclareLaunchArgument("use_fake_hardware", default_value="true"),
            DeclareLaunchArgument("use_rviz", default_value="false"),
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(moveit_launch),
                launch_arguments={
                    "robot_ip": LaunchConfiguration("robot_ip"),
                    "use_fake_hardware": LaunchConfiguration("use_fake_hardware"),
                    "use_rviz": LaunchConfiguration("use_rviz"),
                }.items(),
            ),
            Node(package="ws_bridge", executable="ws_bridge", name="ws_bridge", output="screen"),
        ]
    )
